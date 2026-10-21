# RecycleOldTech Email Triage Agent

A human-in-the-loop email automation: polls the `hello@recycleoldtech.com`
PrivateEmail inbox over IMAP, classifies and drafts replies with Gemini,
posts each draft to Discord with **Approve** / **Edit** / **Reject**
buttons, and sends only after manual approval.

Full design: [`docs/EMAIL_IMPLEMENTATION_PLAN.md`](docs/EMAIL_IMPLEMENTATION_PLAN.md).
Build roadmap: [`docs/ACTION_PLAN.md`](docs/ACTION_PLAN.md).

## Architecture

```
PrivateEmail (IMAP) -> /api/poll (Vercel cron, every 15 min)
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
  pre-filter config (ROI; other brands carry theirs in `lib/brands/`).
- `DD_EMAIL_USER`, `DD_EMAIL_PASS`, `DD_DISCORD_CHANNEL_ID` — the
  DowntownDry mailbox + approval channel (skipped cleanly when absent).
- `EBL_EMAIL_USER`, `EBL_EMAIL_PASS`, `EBL_DISCORD_CHANNEL_ID` — the
  eBikeLocal mailbox + approval channel (skipped cleanly when absent).

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

- **Cron:** registered in `vercel.json` — `/api/poll` (ROI) at
  `*/15 * * * *` , `/api/poll/downtowndry` and `/api/poll/ebikelocal`
  at the same schedule (all three fire together so the Neon database
  wakes once per 15 min and can suspend in between; the
  path-segment rewrite maps it to `/api/poll?brand=<id>` — cron
  paths stay plain, `?brand=` remains supported in the handler).
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

`vercel.json` defines three crons, all at `*/15 * * * *`: `/api/poll` (the
ROI brand, the default when `?brand=` is absent),
`/api/poll/downtowndry` and `/api/poll/ebikelocal` (rewritten to
`/api/poll?brand=<id>`; cron paths are plain path segments, while
the handler keeps direct `?brand=` support). The endpoint authorizes via
the `Authorization: Bearer $CRON_SECRET` header (header-only; the secret
is never accepted via query string).

### Multi-brand (Task 3)

Each brand is a `BrandProfile` in `lib/brands/` (prompt, categories,
pre-filter config, signature, per-brand env prefix). Per brand:

- **Env:** ROI uses the shared `EMAIL_*` / `DISCORD_CHANNEL_ID` vars.
  DowntownDry uses `DD_EMAIL_USER`, `DD_EMAIL_PASS`,
  `DD_DISCORD_CHANNEL_ID`; eBikeLocal uses `EBL_EMAIL_USER`,
  `EBL_EMAIL_PASS`, `EBL_DISCORD_CHANNEL_ID`. A brand with missing vars is skipped cleanly
  by its poll (`200 {"reason":"not_configured"}`, not a 500).
- **Sync cursor:** `email_sync_state` is keyed `<brandId>:INBOX`
  (`roi:INBOX`, `downtowndry:INBOX`, `ebikelocal:INBOX`) so mailboxes never share a lastUid.
- **DB rows:** `email_queue.brand` records the owning brand; approve /
  edit / reject load the row, resolve `getBrand(row.brand)` and send via
  that brand's SMTP mailbox, From name and signature. Cards are titled
  `[ROI] ...` / `[DD] ...` / `[EBL] ...` and post to the brand's own channel; alerts go
  to the channel of the brand they came from.
- **Pre-filters:** ROI still reads the `AUTOMATED_FORM_*` / `NEWSLETTER_*`
  / `DMARC_*` env vars; DowntownDry uses its profile config (no form
  filter; newsletter matches the subject `New Newsletter Subscriber`).
  Web3Forms sender checks match the `@web3forms.com` DOMAIN, not the
  `notify@` local part (DD's real sender is plus-addressed:
  `notify+kjvf7p@web3forms.com`). eBikeLocal has no form or newsletter
  filter either (its contact form and shop-claim mail must reach Gemini);
  only DMARC and bounce apply.
- **Newsletter capture (DD):** a matched signup is parsed
  (`email : x` body line, page name from the subject suffix), upserted
  into `newsletter_subscribers` (unique per brand+email), and announced
  once as `📬 New newsletter subscriber: x (Page)` to DD's channel.
  Repeat signups refresh `last_seen_at` silently.
- **Migrations:** `0005_multi_brand.sql` adds `email_queue.brand` and
  `newsletter_subscribers`, and adopts the pre-existing ROI cursor row as
  `roi:INBOX`. Apply with `npm run db:migrate` (coordinate with adam —
  do not run ad hoc).

This project targets **Vercel Pro** (sub-hourly cron + 60s
`maxDuration`). If forking to Vercel Hobby (which allows 1 cron job at
daily minimum only), remove the `crons` block from `vercel.json` and
drive the endpoint from an external scheduler (cron-job.org, GitHub
Actions, etc.) hitting the secret-guarded URL every 15 minutes, and drop
`maxDuration` to the Hobby ceiling.

## Layout

```
api/           serverless endpoints
  poll.ts      cron target: fetch + classify + DB + post card
  discord.ts   interaction handler: approve/edit/reject
lib/           shared logic
  db.ts        singleton Drizzle client over @neondatabase/serverless
  mail/        IMAP, body cleaning, pre-filter matcher, recipient + headers + templates
  gemini/      Gemini client + prompt
  discord/     REST helpers, signature verification
  poll/        per-message runner (incremental + backlog)
  site/        city-page index + recycling_help URL resolver
  smtp.ts      outbound reply sender
db/            Drizzle schema
  schema.ts    email_queue + email_sync_state
drizzle/       generated migrations
scripts/       one-shot utilities (preflight, db-smoke, backfill, sync:cities, reconcile:seen, bounce:digest)
types/         env types + helpers
docs/          implementation plan, action plan, triage-fix spec
```

## Operations runbook

One-shot utilities (all `CRON_SECRET`-independent; run locally with `npm run <script>`):

- `npm run backfill:reply-to` — re-fetch the `Reply-To` header for
  existing rows and report which already-sent replies went to the wrong
  address (the Web3Forms bug — see `docs/SPEC_TRIAGE_FIXES.md` §2.2).
  Run once after deploying the Reply-To fix.
- `npm run reconcile:seen` — drain the existing pile of unread mail that
  should have been marked read but wasn't (the markSeen deadlock — §1.5).
  Leaves pending cards and error rows untouched. Run once after
  deploying the markSeenBatch fix.
- `npm run retry:errors` — re-run Gemini classification for `status=error`
  rows whose failure was in the classify stage (e.g. after a model
  retirement). Recovers what it can; leaves still-failing rows as error.
- `npm run sync:cities` — refresh `assets/city-index.json` from
  `https://www.recycleoldtech.com/api/cities-data`. Validates before
  overwriting. Run on each release or monthly.
- `npm run bounce:digest` — post a weekly summary of pre-filtered bounces
  to the Discord approval channel. Intended for a weekly cron.
- `npm run refresh:cards` — re-edit existing pending Discord cards in
  place to the current card format (idempotent, preserves message ids).
- `npm run mark:read` — bulk-mark EVERY unread message read. Nuclear
  option; prefer `reconcile:seen` which respects pending/error rows.
