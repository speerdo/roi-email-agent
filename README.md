# RecycleOldTech Email Triage Agent

A human-in-the-loop email automation: polls the `hello@recycleoldtech.com`
PrivateEmail inbox over IMAP, classifies and drafts replies with Gemini,
posts each draft to Discord with **Approve** / **Edit** / **Reject**
buttons, and sends only after manual approval.

Full design: [`docs/EMAIL_IMPLEMENTATION_PLAN.md`](docs/EMAIL_IMPLEMENTATION_PLAN.md).
Build roadmap: [`docs/ACTION_PLAN.md`](docs/ACTION_PLAN.md).

## Architecture

```
PrivateEmail (IMAP) -> /api/poll (Vercel cron, every 10 min)
  -> deterministic pre-filters (recycling-form, newsletter, DMARC)
     -> match: mark \Seen, status=skipped, no LLM, no card
  -> Gemini classify + draft
  -> upsert to Neon email_queue (status=pending)
  -> post Discord card with [Approve] [Edit] [Reject]
User taps button in Discord -> /api/discord handler
  -> Approve: send via SMTP, status=sent, edit card
  -> Edit: modal prefilled with draft -> save -> send
  -> Reject: status=rejected, edit card
```

Two serverless endpoints + Neon (Postgres) as the shared store.

## Stack

- **Runtime:** Vercel serverless functions + Vercel Cron (Pro tier, sub-hourly).
- **DB:** Neon (Postgres) via `@neondatabase/serverless` + Drizzle ORM.
- **LLM:** Gemini 2.5 Flash (classify + draft).
- **Email in:** `imapflow` + `mailparser`.
- **Email out:** `nodemailer` over PrivateEmail SMTP.
- **Notifications/approval:** Discord bot + interactions endpoint (Ed25519).

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy the template and fill in real values. The `.env` file is gitignored
and never committed.

```bash
cp .env.example .env
$EDITOR .env
```

Every key is documented inline in `.env.example`. The required set, with
the four pre-filter blocks defaulted for RecycleOldTech:

- `EMAIL_*` — PrivateEmail IMAP/SMTP host/port/user/pass.
- `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_CLASSIFY_MODEL`.
- `DATABASE_URL` — Neon pooled connection string.
- `DISCORD_BOT_TOKEN`, `DISCORD_PUBLIC_KEY`, `DISCORD_CHANNEL_ID`
  (provisioned in Phase 6, not needed for Phase 0-5).
- `CRON_SECRET` — long random string guarding `/api/poll`.
- `AUTOMATED_FORM_*`, `NEWSLETTER_*`, `DMARC_*` — deterministic
  pre-filter config.

### 3. Preflight connectivity check

After populating `.env` (Discord vars optional until Phase 6), verify
Neon, IMAP, SMTP, and Gemini all work:

```bash
npm run preflight
```

All five checks (env presence, Neon, IMAP, SMTP, Gemini) must PASS before
proceeding. Re-run after any credential rotation.

### 4. Run / build / test

```bash
npm run dev          # vercel dev (requires `vercel login`)
npm run typecheck    # tsc --noEmit
npm run lint         # eslint .
npm test             # vitest run
npm test:watch       # vitest watch
```

### 5. Database

Drizzle schema lives in `db/schema.ts`. Apply to Neon:

```bash
npm run db:generate  # emit a migration SQL file under drizzle/
npm run db:migrate   # apply migrations to Neon
npm run db:smoke     # round-trip insert/select/delete on both tables
npm run db:studio    # drizzle-kit studio (inspect the DB in a browser)
npm run db:push      # quick schema push (good for iterating, no migration file)
```

### 6. Deploy

Link the Vercel project (Pro tier required for sub-hourly cron), add every
`.env` key as a Production environment variable in the Vercel dashboard
(mark all as not-exposed to Preview/Development), and deploy:

```bash
vercel --prod
```

After the first deploy, set the Discord **Interactions Endpoint URL** in
the Discord Developer Portal to `https://<prod-domain>/api/discord` and
confirm the PING returns PONG.

## Live wiring (Phase 7)

Once deployed to production:

- **Cron:** registered in `vercel.json` (`/api/poll` at `*/10 * * * *`).
  Confirmed in the Vercel dashboard → Cron Jobs tab (Vercel Pro required
  for sub-hourly).
- **Discord Interactions Endpoint URL:** in the Discord Developer Portal →
  General Information → Interactions Endpoint URL, set
  `https://roi-email-agent.vercel.app/api/discord`. Discord sends a PING
  on save; the deployed handler returns PONG (type 1) after Ed25519
  signature verification. If the portal reports "PONG failed", check that
  `DISCORD_PUBLIC_KEY` is set on Vercel (Production env) and matches the
  app's public key exactly.
- **Manual poll trigger (bypassing the cron):**
  ```bash
  curl -H "Authorization: Bearer $CRON_SECRET" \
    https://roi-email-agent.vercel.app/api/poll
  ```
  Returns a JSON run summary (counts by category/status/skip_reason,
  `lastUidBefore`/`lastUidAfter`, errors). Use this to drain a burst of
  mail without waiting for the next cron tick, or to verify a deploy.
- **Env vars:** all keys live in Vercel Project Settings as **Production
  only** (not exposed to Preview/Development — preview deploys use Vercel
  dev's local `.env`). `DATABASE_URL` uses the `sslmode=require`-only form
  (no `channel_binding=require`, which the `@neondatabase/serverless` HTTP
  driver doesn't need and which can cause handshake errors).

## Cron

`vercel.json` defines a `*/10 * * * *` cron hitting `/api/poll`. The
endpoint authorizes via the `Authorization: Bearer $CRON_SECRET` header
(header-only; the secret is never accepted via query string).

This project targets **Vercel Pro** (sub-hourly cron + 60s
`maxDuration`). If forking to Vercel Hobby (which allows 1 cron job at
daily minimum only), remove the `crons` block from `vercel.json` and
drive the endpoint from an external scheduler (cron-job.org, GitHub
Actions, etc.) hitting the secret-guarded URL every 10 minutes, and drop
`maxDuration` to the Hobby ceiling.

## Layout

```
api/           serverless endpoints
  poll.ts      cron target: fetch + classify + DB + post card
  discord.ts   interaction handler: approve/edit/reject
lib/           shared logic
  db.ts        singleton Drizzle client over @neondatabase/serverless
  mail/        IMAP, body cleaning, pre-filter matcher
  gemini/      Gemini client + prompt
  discord/     REST helpers, signature verification
  poll/        per-message runner (incremental + backlog)
  smtp.ts      outbound reply sender
db/            Drizzle schema
  schema.ts    email_queue + email_sync_state
drizzle/       generated migrations
scripts/       one-shot utilities (preflight, db-smoke)
types/         env types + helpers
docs/          implementation plan + action plan
```

## Background modes

Once the incremental poller is live, drain the pre-existing backlog via
two CRON_SECRET-guarded modes on `/api/poll`:

- `?mode=backlog-classify&since=YYYY-MM-DD&limit=25` — inventory only,
  noise marked read + skipped, real email classified but left unread,
  no drafts, no cards. Returns a summary with `nextSince` for paging.
- `?mode=backlog-draft&category=listing_request` — drafts + cards for
  the chosen category, on demand. Clear at your pace.

Both modes are no-ops on `email_sync_state.last_uid` (the incremental
cursor); they rely entirely on `message_id` dedupe.

See `docs/ACTION_PLAN.md` Phase 8 for the full runbook.