# Action Plan — RecycleOldTech Email Triage Agent

Working from `docs/EMAIL_IMPLEMENTATION_PLAN.md`. This file breaks the build into
phased chunks. **Every phase ends the same way: review with Adam, then commit
before starting the next phase.** No phase begins until the previous one is
committed.

Conventions:

- Work takes place in this dedicated repo (`roi-email-agent`). No framework.
- TypeScript, ESM, Vercel serverless functions.
- Secrets live in `.env` (gitignored). Defaults/samples in `.env.example`.
- Lint/typecheck must pass before each commit (`npm run typecheck`,
  `npm run lint` — wired up in Phase 1).
- Each commit message prefix `phase-N:` matching the phase below.
- Tests run via `vitest` (`npm test`) — declared in Phase 1, used from Phase 3.
- Where a downstream decision blocks a phase, an explicit **GATE** notes what
  Adam needs to provide before that phase can commit.

---

## Env var status at start of plan

| Var                                                               | Status                             |
| ----------------------------------------------------------------- | ---------------------------------- |
| `EMAIL_*` (IMAP/SMTP/user/pass)                                   | filled                             |
| `GEMINI_API_KEY`, `GEMINI_MODEL`, `GEMINI_CLASSIFY_MODEL`         | filled                             |
| `DATABASE_URL` (Neon)                                             | filled (see Phase 2 caveat)        |
| `CRON_SECRET`                                                     | filled                             |
| Pre-filter config (`AUTOMATED_FORM_*`, `NEWSLETTER_*`, `DMARC_*`) | filled with plan defaults          |
| `DISCORD_BOT_TOKEN`                                               | **missing — requested at Phase 6** |
| `DISCORD_PUBLIC_KEY`                                              | **missing — requested at Phase 6** |
| `DISCORD_CHANNEL_ID`                                              | **missing — requested at Phase 6** |

Only the Discord app is unprovisioned. Adam will create it before Phase 6
starts — that phase is the first that actually needs those credentials.
Adam is already on Vercel Pro, so the sub-hourly cron is supported.

---

## Open deployment decision to settle in Phase 1 (can block design)

>>> **Vercel tier:** Adam is already on **Vercel Pro**. The
>>> `*/10 * * * *` sub-hourly cron in `vercel.json` is supported out of
>>> the box, and `maxDuration: 60` per function is within the Pro
>>> ceiling. No external scheduler fallback is needed. (Hobby-only
>>> note kept below as a historical footnote for anyone forking this
>>> repo: Hobby allows 1 cron job at daily minimum only.)

---

## Phase 0 — Connectivity sanity check (no app code yet)

Goal: confirm every provisioned credential actually works BEFORE we build
real logic on top of it. A bad `EMAIL_PASS` or a mis-typed Neon string
discovered here is 5 minutes of pain; discovered in Phase 5 it is a
re-architecture of assumptions.

Tasks:

- [x] `scripts/preflight.ts` (committed under `scripts/`, runnable via
      `tsx scripts/preflight.ts`) that, in order, exercises:
      1. **Env presence** — `getEnv()` asserts every required key is set and
         non-empty. Lists any missing. (Discord vars are allowed-missing at
         this point — the script skips those checks with a printed note.)
      2. **Neon** — open the `@neondatabase/serverless` HTTP driver on
         `DATABASE_URL`, run `SELECT 1`. Reports success or the raw error.
         **If this fails with a channel_binding / SSL error**, strip
         `&channel_binding=require` (and possibly `sslmode=require`) from
         the URL in `.env` and retry — the HTTP driver handles TLS itself
         and these standard-lib params can confuse it.
      3. **IMAP** — `imapflow` connect to `mail.privateemail.com:993`,
         login as `EMAIL_USER`/`EMAIL_PASS`, open `INBOX`, list the
         top-level mailboxes, close, logout. Reports success or auth error.
      4. **SMTP** — `nodemailer` createTransport against PrivateEmail
         SMTP, call `verify()` (does NOT send mail). Reports success.
      5. **Gemini** — `@google/genai` call with `GEMINI_API_KEY`, send a
         trivial "reply with the single word OK" prompt to `GEMINI_MODEL`,
         print the response. Confirms key + model id.
- [x] Run the preflight locally. Resolve any failures (often a typo,
      a wrong pooled-vs-direct Neon host, or the channel_binding issue
      above) before proceeding.
- [x] `README.md` snippet documenting how to re-run preflight after any
      credential rotation.

**Review:** Adam sees green output for Neon / IMAP / SMTP / Gemini. Any
failing credential is fixed in `.env` and re-verified before commit.
**Commit:** `phase-0: preflight connectivity check script`

---

## Phase 1 — Repo scaffold + tooling

Goal: a buildable, typecheckable, lintable, empty-shell project wired for
Vercel, with the cron decision from above resolved.

Tasks:

- [x] `package.json` — `type: module`, `private: true`. Scripts:
      `dev` (vercel dev), `build` (tsc --noEmit), `typecheck` (tsc --noEmit),
      `lint` (eslint), `test` (vitest run), `test:watch`, `db:push`
      (drizzle-kit push), `db:studio` (drizzle-kit studio).
      Runtime deps (pinned, single source of truth):
      `@neondatabase/serverless`, `drizzle-orm`, `imapflow`, `mailparser`,
      `nodemailer`, `@google/genai`, `discord-interactions`
      (picks `tweetnacl` transitively — no need to add it separately).
      DevDeps: `typescript`, `tsx`, `drizzle-kit`, `vitest`,
      `@types/node`, `@types/nodemailer`, `@types/imapflow`,
      `@types/mailparser`, `eslint`, `@typescript-eslint/eslint-plugin`,
      `@typescript-eslint/parser`, `typescript-eslint`.
- [x] `tsconfig.json` — strict, ESM, `target: ES2022`,
      `module: NodeNext`, `moduleResolution: NodeNext`,
      `resolveJsonModule`, `skipLibCheck`, `noUncheckedIndexedAccess`.
      `include` covers `api/`, `lib/`, `db/`, `scripts/`, `types/`.
- [x] `vercel.json` (Adam is on Vercel Pro, so sub-hourly cron + 60s
      `maxDuration` are supported):
      `{ "crons": [{ "path": "/api/poll", "schedule": "*/10 * * * *" }] }`,
      `functions.api/*.maxDuration` ~60. `"cleanUrls": true`.
- [x] `eslint.config.js` (flat) — `typescript-eslint` strict,
      `no-unused-vars` as error, `no-throw-literal`, explicit `any` warn.
      Ignores `.vercel/`, `dist/`, `drizzle/` generated output.
- [x] `vitest.config.ts` — node environment, `include: ['**/*.test.ts']`.
- [x] Directory skeleton: `api/`, `lib/`, `lib/mail/`, `lib/discord/`,
      `lib/poll/`, `lib/gemini/`, `db/`, `drizzle/`, `types/`, `scripts/`.
- [x] `types/env.ts` — `Env` interface mirroring the `.env.example` keys
      with types (numbers for ports, booleans for `*_MARK_READ`). A
      `getEnv()` helper that reads once at cold start, coerces types,
      throws with a clear message on any missing required key. Discord
      vars are optional here; they're asserted explicitly at the top of
      Phase 6 endpoints.
- [x] Placeholder endpoints so Vercel builds:
      - `api/poll.ts` — returns `{ status: 'not implemented' }` 501.
      - `api/discord.ts` — returns `{ status: 'not implemented' }` 501.
- [x] `README.md` — purpose, env setup (point at `.env.example`),
      preflight instructions (run `tsx scripts/preflight.ts`),
      dev/deploy commands, the cron decision (Pro vs external scheduler),
      link to both docs.
- [x] Confirm all of: `npm install`, `npm run typecheck`, `npm run lint`,
      `npm test` (0 tests, green), and `npm run dev` → `curl localhost:3000/api/poll`
      returns the 501 placeholder.

**Review:** Adam inspects package versions, scripts, tsconfig strictness,
verifies the cron decision is reflected in `vercel.json`, and that `vercel
dev` boots both placeholder endpoints.
**Commit:** `phase-1: scaffold repo, tooling, empty endpoints`

---

## Phase 2 — Database schema + Neon migration

Goal: `email_queue` and `email_sync_state` tables live in Neon, accessed
via Drizzle over the `@neondatabase/serverless` HTTP driver.

Caveat carried from Phase 0: **if preflight failed on Neon with a
channel_binding error and we stripped `&channel_binding=require` from
`.env`, confirm the working string is also reflected in Vercel env vars
during Phase 7. The `.env.example` template keeps the "clean" form.**

Tasks:

- [x] `db/schema.ts` — Drizzle definitions for both tables (plan section 6).
      Columns, defaults, and indexes match the plan SQL exactly. Use
      `text` for category/status (not pg enums — easier to extend per the
      plan's v2 multi-domain posture).
      - `email_queue`: id (uuid, default `gen_random_uuid()`), message_id
        (text, unique not null), imap_uid (integer), from_addr (text, not
        null), from_name (text), subject (text), body_snippet (text),
        category (text), should_reply (boolean default false),
        draft_reply (text), status (text default 'pending'),
        skip_reason (text), discord_message_id (text), in_reply_to (text),
        email_references (text), error_detail (text),
        received_at (timestamptz), created_at (timestamptz default now()),
        updated_at (timestamptz default now()).
      - `email_sync_state`: mailbox (text primary key), last_uid (integer
        default 0), updated_at (timestamptz default now()).
      - Indexes on `email_queue(status)` and `email_queue(received_at)`.
- [x] `drizzle.config.ts` pointing `url` at `process.env.DATABASE_URL`,
      `dialect: 'postgresql'`, schema `./db/schema.ts`, out `./drizzle`.
- [x] `lib/db.ts` — singleton: `neon(process.env.DATABASE_URL!)` ->
      `drizzle(client, { schema })`. Export the `db` object plus a
      `closeDb()` no-op (HTTP driver is connectionless; documented so no
      one tries to pool it later).
- [x] **Migration approach:** use `drizzle-kit generate` to produce a SQL
      migration file under `drizzle/` (committed to git — gives us
      history), then `drizzle-kit migrate` to apply. Rationale: costs
      nothing over `push` and we get a reviewable diff for a production
      DB. (`push` is the fallback if `migrate` misbehaves.)
- [x] Run `npm run db:push` as a fallback / quick check; primary path is
      generate + migrate.
- [x] Smoke test: `scripts/db-smoke.ts` (tsx-runnable) inserts one row
      in each table, selects it back, deletes it. Prints rows-touched.
      Not run on every CI — manual Phase-2 verification only.
- [x] Update `.env.example` if the `DATABASE_URL` form was changed during
      preflight (remove `&channel_binding=require` if it broke
      `@neondatabase/serverless`).

**Review:** Adam confirms tables exist in Neon (console or
`drizzle-kit studio`) with the exact columns, the migration file is in git,
and `db-smoke.ts` round-trips cleanly.
**Commit:** `phase-2: drizzle schema + neon migration`

---

## Phase 3 — Shared lib: IMAP fetch + pre-filter matcher

Goal: everything needed to read mail and apply deterministic skips BEFORE
any LLM call. No Gemini, no Discord, no DB writes yet (other than logging).

Tasks:

- [x] `lib/env.ts` — finalize the `getEnv()` helper from Phase 1; add
      helpers for comma-split env lists (`getCommaList('DMARC_SUBJECTS')`)
      and booleans (`getBool('AUTOMATED_FORM_MARK_READ')`).
- [x] `lib/imap.ts`:
      - `connectImap()` — opens an `ImapFlow` instance against
        `EMAIL_IMAP_HOST:EMAIL_IMAP_PORT`, auth `EMAIL_USER/EMAIL_PASS`,
        TLS. Logger wired to the shared logging helper.
      - `fetchSinceUid(mailbox, lastUid)` — incremental path; fetches
        UIDs > lastUid, **`peek: true`** so reading does NOT set `\Seen`.
        Yields `{uid, headers, body, messageId, references, receivedAt}`.
      - `fetchByDateRange(mailbox, since, opts?)` — backlog path; same
        peek semantics; takes optional `limit` and `offsetUid` for
        resumable batching.
      - `markSeen(uid)` — explicit add `\Seen` flag (the ONLY operation
        that sets `\Seen`).
      - `appendSent(rawMessage)` — Phase 9 stub; logs "not implemented"
        for now so Phase 4's SMTP path can call it without branching.
      - All operations wrapped in try/finally that closes the connection.
- [x] `lib/mail/clean.ts`:
      - `cleanBody(raw)` — strip signature blocks (`-- `, `Best regards,`
        etc.), strip quoted reply history (`> `-prefixed lines,
        `On <date> ... wrote:` blocks), collapse whitespace, truncate to
        ~2000 chars at a word boundary.
      - `parseFromHeader(raw)` -> `{address, name}` used by pre-filter
        sender matching.
- [x] `lib/mail/prefilter.ts` — implements plan section 7a:
      - `matchRecyclingRequest(subject, from)` — BOTH an
        `AUTOMATED_FORM_SUBJECTS` prefix match (case-insensitive
        `startsWith` on any entry) AND `AUTOMATED_FORM_FROM` substring
        match in the sender address. Both required.
      - `matchNewsletter(subject, from)` — sender contains
        `NEWSLETTER_FROM` OR subject matches a `NEWSLETTER_SUBJECTS`
        entry (when set).
      - `matchDmarc(subject, from)` — subject contains any
        `DMARC_SUBJECTS` entry; AND sender contains `DMARC_FROM` when set.
      - `runPrefilters(msg)` returns one of:
        `{matched: true, category, skipReason, markRead}` or
        `{matched: false}`. Checked in plan order: recycling, newsletter,
        dmarc. Only the FIRST match wins.
      - Comma-separated lists parsed once at module load (cached).
      - Case-insensitive throughout.
- [x] `lib/logging.ts`:
      - `RunSummary` builder: counters by category, by skip_reason,
        errors[], processed count, lastUidBefore/After, durationMs.
      - `toJSON()` and `toDiscordLine()` (used by Phase 5/8).
- [x] `lib/mail/prefilter.test.ts` and `lib/mail/clean.test.ts` (vitest)
      covering every section-14 checklist row that's testable without
      IMAP/LLM:
      - Recycling request happy path: web3forms sender + recycling
        subject prefix -> matched.
      - **Safety rule:** web3forms sender + DIFFERENT subject (e.g.
        "Contact form") -> NOT matched (falls through to LLM).
      - Subject prefix only, no web3forms sender -> NOT matched.
      - Waste Advantage newsletter sender -> matched.
      - DMARC `Report domain: ...` subject -> matched.
      - Body cleaning: signature + quoted reply history stripping.
      - Truncation at ~2k chars at a word boundary.

**Review:** Adam reviews matcher logic and tests against the section-7a
safety rule and the section-14 test checklist. Run `npm test` and confirm
all green.
**Commit:** `phase-3: imap fetch util + deterministic pre-filters`

---

## Phase 4 — Shared lib: Gemini classify+draft + SMTP sender

Goal: the LLM and the outbound email path are ready, with NO endpoints yet.

Tasks:

- [x] `lib/gemini/prompt.ts` — exports the system prompt as a constant
      matching plan section 9 verbatim (About RecycleOldTech, routing
      rules, reply-worthy/not-reply-worthy categories, JSON schema,
      reference examples, "no em dashes" voice rule, sign-off as
      RecycleOldTech / Adam). Build the user-content string from
      `{from, subject, snippet}` with a small `buildPrompt(msg)` helper.
- [x] `lib/gemini/index.ts` — single client using `@google/genai`:
      - `classifyAndDraft({from, subject, snippet})` ->
        `Promise<ClassifyResult>` matching the JSON shape from section 9.
      - Configures `responseMimeType: 'application/json'` if supported
        by the SDK at build time; otherwise parses defensively.
      - **Defensive parse:** strip ``` fences and any leading/trailing
        prose, `JSON.parse`, on failure return
        `{category: 'other', should_reply: false, draft_reply: '',
        reason: 'parse_failed: <snippet>'}` and log the raw output.
      - Models: classifies with `GEMINI_MODEL` for now; structure the
        code so the Phase 9 split (classify with `GEMINI_CLASSIFY_MODEL`,
        draft with `GEMINI_MODEL`) is a one-line change. Stub a
        `draftOnly({from, subject, snippet, category})` function
        signature that Phase 9 fills in.
- [x] `lib/smtp.ts`:
      - `sendReply({to, subject, text, inReplyTo, references})` using
        `nodemailer` SMTP transport against PrivateEmail,
        `from: '"RecycleOldTech" <EMAIL_USER>'`, `inReplyTo` + `references`
        set for threading. Returns the sent `Message-Id` (or void —
        confirm during implementation).
      - After send, call `appendSent()` from `lib/imap.ts` (Phase 9
        stub logs "not implemented"). This is the plan section 11
        nice-to-have, wired in now so Phase 9 just fills in the body.
      - Transport created per-invocation (serverless-friendly — no
        shared pool that dies between cold starts).
- [x] `scripts/test-gemini.ts` — runnable via `tsx`, takes a hard-coded
      fake email input (override via `--from`, `--subject`, `--body` if
      simple arg parsing is trivial), prints the parsed `classifyAndDraft`
      output. Includes three canned inputs matching plan section 14:
      1. The canonical "Please list us" listing request.
      2. "Do you buy used laptops?" out-of-scope.
      3. A cold "boost your SEO traffic" sales pitch.
      Adam can edit and re-run for ad-hoc cases.
- [x] `scripts/test-smtp.ts` — guarded: refuses to run without
      `--to <real-address>` and prints a confirmation prompt before
      sending. Only run on Adam's explicit go-ahead.

**Review:** Adam runs `test-gemini.ts` against the three canned inputs
plus anything else he wants to throw at it and confirms categories,
`should_reply`, and voice match the plan's expectations (especially:
listing_request draft routes to https://recycleoldtech.com/claims without
asking them to email details back; out-of-scope reply does NOT invent a
service; no em dashes anywhere).
**Commit:** `phase-4: gemini classify+draft + smtp sender`

---

## Phase 5 — `api/poll`: incremental path + pre-filters + Gemini + DB upsert

Goal: the cron endpoint runs end-to-end on NEW mail (UID-incremental).
No Discord cards yet — those wire in Phase 6 after Adam provisions Discord.

Tasks:

- [x] `api/poll.ts`:
  - **Auth:** verify `CRON_SECRET` from the `Authorization: Bearer
    <secret>` **header only**. Do NOT accept `?secret=` — query strings
    are logged by Vercel and would leak the secret. 401 on mismatch.
  - **Sync state:** load `last_uid` from `email_sync_state` for the key
    `${EMAIL_USER}/INBOX`. If absent, seed with 0 (and on the first real
    run, document that this processes everything from UID 0 forward —
    which for a fresh poller is correct; the backlog modes in Phase 8
    are for the EXISTING unread pile before the poller went live).
  - **Fetch:** `fetchSinceUid` with peek. Incremental path only; the
    `?mode=` backlog modes come in Phase 8.
  - **Per message** (in a try/catch so one bad email doesn't kill the
    run):
    1. Parse via `mailparser` -> from, from_name, subject, text body,
       Message-ID, References.
    2. **Dedupe:** skip if `message_id` already exists in `email_queue`.
    3. **Pre-filters** (`runPrefilters`). On match: `markSeen(uid)` if
       the filter's `*_MARK_READ` is true; insert row `status='skipped'`
       with `category` + `skip_reason`; **NO Gemini call**, **NO card**.
       Continue.
    4. `cleanBody` -> ~2k snippet.
    5. `classifyAndDraft` -> category, should_reply, draft_reply, reason.
    6. Insert row `status='pending'` with category, should_reply,
       draft_reply, threading headers (in_reply_to, email_references),
       received_at.
    7. **Routing (Phase-5 stub):**
       - `should_reply === true` AND category != spam -> log
         "would post card for <id>" (Discord wiring is Phase 6).
       - category == spam -> `status='skipped'`, **do NOT mark read**,
         **no card** (stays visible in webmail per the plan's safety net).
       - other no-reply categories -> `status='skipped'`, no card.
    8. On exception: insert row `status='error'` with `error_detail`,
       increment the run's error counter, **do NOT advance `last_uid`
       past this UID** (so the next run retries it).
  - **Update sync state:** after the batch, set `last_uid` to the
    highest UID that was successfully persisted (not processed —
    persisted; a message whose row failed to insert does not advance
    the cursor).
  - **Return:** the `RunSummary` JSON (counts by category, by
    skip_reason, errors, duration, lastUidBefore/After).
- [x] `lib/poll/runner.ts` — extract the per-message loop so the backlog
      modes (Phase 8) can reuse it without duplicating logic. Takes a
      "fetch iterable" + a "routing policy" so incremental vs backlog
      differ only in those two params.
- [x] Local smoke test: `vercel dev`, then
      `curl -H "Authorization: Bearer $CRON_SECRET" localhost:3000/api/poll`.
      Confirm: connects to IMAP, classifies at least one real message,
      writes a row, advances `last_uid`, returns a sensible summary.
      Verify in Neon that noise categories are `status='skipped'` and
      `markSeen` was called; real email rows are `status='pending'` and
      still UNREAD on the server.

**Review:** Adam triggers a poll against the live mailbox, verifies rows
in Neon (skipped noise marked read server-side, pending real mail left
unread), sees the "would post card" logs, confirms no card was actually
posted yet (expected).
**Commit:** `phase-5: poller incremental path + pre-filters + gemini + db`

> **Post-commit fixes (live-testing review, found three reliability bugs
> that typecheck/lint/unit tests couldn't catch — only running against the
> real mailbox surfaced them):**
> 1. **Process crash on IMAP socket error** — `lib/imap.ts`'s `ImapFlow`
>    client had no `error` listener; Node throws and kills the process on
>    any unhandled `error` event (observed live on a socket timeout).
>    Fixed: `connectImap()` now attaches a logging listener.
> 2. **Batch runtime risked exceeding Vercel's `maxDuration`** — a real
>    batch of ~24 messages took up to 337s, and ImapFlow's default 300000ms
>    (5 min) socket timeout meant a stalled connection could hang for most
>    of that before erroring. Fixed three ways: `lib/imap.ts` sets
>    `socketTimeout: 30_000` (fail fast instead of hanging ~5min),
>    `api/poll.ts`'s `POLL_BATCH_LIMIT` dropped from 25 to 10 (cron runs
>    every 10min, so backlog just drains over more ticks), and
>    `vercel.json` raised `maxDuration` from 60 to 120 for headroom.
> 3. **Partial-batch progress was lost on a mid-batch connection failure**
>    — `runBatch()` only returned `highestPersistedUid` on clean
>    completion; a mid-loop throw discarded it, so `last_uid` stayed stuck
>    even after many messages were genuinely persisted. Fixed by mutating
>    `summary.highestPersistedUid` incrementally (`lib/logging.ts`'s
>    `RunSummary`) so it survives a throw; `api/poll.ts` now advances the
>    cursor from that field after BOTH the success path and the catch path.
>
> Side effect of bug #1/#2 existing before they were fixed: live test runs
> inserted 9 real `pending` rows (genuine inbound leads) before Phase 6's
> card-posting existed. Backfilled via the new `scripts/backfill-cards.ts`
> (see Phase 6 status note).

---

## === GATE: Discord app provisioning ===

Before Phase 6 begins, Adam must provision the Discord application.
This is the first phase that needs those credentials. Steps:

1. Go to https://discord.com/developers -> **New Application** (name it
   e.g. "RecycleOldTech Triage").
2. **Add a Bot** -> copy the **Bot Token** -> `.env: DISCORD_BOT_TOKEN`.
3. Copy the **Application Public Key** (General Information page) ->
   `.env: DISCORD_PUBLIC_KEY`.
4. In Discord proper: enable Developer Mode (Settings -> Advanced),
   right-click the approval channel -> Copy ID ->
   `.env: DISCORD_CHANNEL_ID`.
5. Add the bot to the server with `Send Messages`, `Manage Messages`
   (needed to edit its own cards), `Read Message History`, and
   `Use Application Commands` permissions.
6. **Interactions Endpoint URL gets set in Phase 7** after we have a
   live `/api/discord` deployed. Leave it blank for now.

Re-run `tsx scripts/preflight.ts` (with the Discord block now enabled —
if Phase 0 didn't include it, the script should check it on demand via
`--with-discord` or simply when the vars are present) to confirm the bot
token is valid and the channel is reachable.

---

## Phase 6 — Discord posting + interaction handler (`api/discord`)

Goal: pending reply-worthy rows become Discord cards; button taps
approve/edit/reject.

Tasks:

- [x] `lib/discord/verify.ts` — Ed25519 signature verification using
      `discord-interactions`' `verifyKey` (which wraps `tweetnacl`).
      Reads `DISCORD_PUBLIC_KEY` + `X-Signature-Ed25519` +
      `X-Signature-Timestamp` headers. Returns 401 on bad signature.
      PING (interaction type 1) -> respond with type 1 (PONG).
- [x] `lib/discord/rest.ts`:
      - `postCard(row)` -> POST a channel message with:
        - embed: title = Subject; **description** = draft reply in a
          `code block` (description has a 4096-char cap vs. a field's
          1024, chosen specifically so typical drafts don't truncate —
          see post-commit fix note below); fields: From, Category,
          Received, and **Original email** (the cleaned inbound snippet,
          also in a code block) so Adam can judge draft-vs-original
          alignment without leaving Discord.
        - action row of 3 buttons labelled `Approve` / `Edit` / `Reject`
          with `custom_id` = `approve:<id>` / `edit:<id>` /
          `reject:<id>`. **Note:** Discord caps `custom_id` at 100
          chars; `<action>:<uuid>` stays well under that.
        - Save the returned message id back into
          `email_queue.discord_message_id`.
      - `editCard(channelId, messageId, {embed, components})` — used to
        update a card after an action (show "Sent"/"Skipped", remove
        buttons).
      - `deferInteraction(interactionId, token)` — respond type 5 (defers
        the source message) so we have time for SMTP send inside
        Discord's 3-sec ACK window.
      - `openEditModal(interactionId, token, row)` — respond type 9
        (modal) with a `TEXT_INPUT` (paragraph style) prefilled with
        `draft_reply`.
- [x] `api/poll.ts` — replace the Phase-5 "would post card" stub with a
      real `postCard(row)` call for reply-worthy rows (should_reply AND
      category != spam).
- [x] `api/discord.ts`:
  - **Always first:** `verifyKey`. 401 on failure. PING -> PONG (200
    with type 1).
  - Parse `custom_id` -> `<action>:<queueId>` (split on first `:`).
  - **Approve:**
    1. `deferInteraction` (SMTP may exceed 3 sec).
    2. Load row by queueId from `email_queue`.
    3. `sendReply({to: row.from_addr, subject: row.subject, text:
       row.draft_reply, inReplyTo: row.in_reply_to, references:
       row.email_references})`.
    4. On success: set `status='sent'`; `markSeen(row.imap_uid)` (real
       email is marked read ONLY at this point, per plan);
       `editCard(...)` to embed "Sent" and remove buttons.
    5. On SMTP failure: set `status='error'` + `error_detail`;
       `editCard(...)` to "Send failed — see logs" and KEEP the buttons
       so Adam can retry.
  - **Reject:** set `status='rejected'`; `markSeen(row.imap_uid)`;
    `editCard(...)` to "Skipped", remove buttons.
  - **Edit:**
    1. `openEditModal` with `draft_reply` prefilled.
    2. The modal submit is a SEPARATE interaction with `custom_id` =
       `edit_submit:<queueId>` (or a Discord modal `custom_id` carrying
       the queueId — pick the SDK-friendly option and document it).
    3. On submit: parse the submitted text, save to `draft_reply`,
       `sendReply`, set `status='sent'`, `markSeen`, `editCard(...)` to
       "Sent (edited)".
- [x] `scripts/test-discord-signature.ts` — generates a valid Ed25519
      signature for a fake PING interaction using the public key, posts
      to `localhost:3000/api/discord` via `vercel dev`, confirms a PONG.
      Then a fake `approve:<test-row-id>` against a test row inserted
      via `db-smoke.ts` — full Approve cycle locally before going live.
- [x] Update Phase 1's `types/env.ts` so Discord vars become required
      inside `api/discord.ts` and `lib/discord/*` (separate `getDiscordEnv()`
      that throws if any of the three is missing — keeps the rest of the
      app runnable without Discord provisioned).
- [x] `scripts/backfill-cards.ts` — one-off, guarded like `test-smtp.ts`
      (lists rows, requires a typed "yes" before posting anything real):
      finds `status='pending' AND discord_message_id IS NULL` and posts a
      card for each via the same `postCard()` `api/poll.ts` uses. Needed
      because `processMessage` dedupes by `message_id` *before* it ever
      reaches the routing/card step, so any pending row inserted before
      card-posting existed (see Phase 5's post-commit fix note) would
      otherwise be permanently invisible to Discord.

**Review:** Adam walks through one full cycle locally: a known
listing_request row gets a card in the test channel, taps Approve,
confirms the email actually lands in the recipient's inbox and threads
correctly (open the thread in webmail), and the Discord card updates to
Sent. Then an Edit cycle (modal prefilled, edited text is what sends).
Then a Reject cycle. Then a deliberate SMTP failure (e.g., wrong recipient)
to confirm the error path keeps the buttons.

> **Status at commit:** card posting is verified live against the real
> channel (one test card posted for an existing pending row via
> `scripts/post-test-card.ts`). PING -> PONG signature verification is
> verified via `scripts/test-discord-signature.ts`. The full Approve /
> Edit / Reject / SMTP-failure live cycles are deferred to Phase 7 —
> since `/api/discord` is not deployed, Discord button taps cannot
> reach the handler yet. Phase 7's review re-runs those cycles against
> the deployed endpoint.
>
> **Post-commit fixes (review feedback, both confirmed live):**
> 1. **Card content**: Adam asked to see the original email alongside the
>    draft (to judge alignment) and noticed long drafts were truncating.
>    Fixed in `lib/discord/rest.ts` — draft moved from a field (1024-char
>    cap) into the embed `description` (4096-char cap); added an
>    "Original email" field sourced from the already-stored
>    `email_queue.body_snippet`. Threaded `bodySnippet` through
>    `RoutingContext` (`lib/poll/runner.ts`), the `cardPoster` in
>    `api/poll.ts`, and `rowToCardRow` in `api/discord.ts`. Both
>    `buildCardPayload` and `buildResolvedCardPayload` now truncate with a
>    visible "…" marker if a value still exceeds its cap, instead of
>    Discord silently cutting it off.
> 2. **Orphaned leads backfilled**: ran `scripts/backfill-cards.ts` against
>    production — posted cards for the 9 pending rows described in
>    Phase 5's post-commit note. All 9 now have a `discord_message_id`.

**Commit:** `phase-6: discord card posting + interaction handler`

---

## Phase 7 — First deploy + live wiring

Goal: running in production with the cron firing and Discord talking back
to the real endpoint.

Tasks:

- [ ] Push the committed branch to GitHub (origin already set).
- [ ] Link or create the Vercel project against this repo.
- [ ] In Vercel Project Settings -> Environment Variables, add every key
      from `.env.example` (same values as `.env`). Mark all as
      **Production only** and **not** exposed to Preview/Development
      (the local `vercel dev` uses `.env` directly). Confirm the
      `DATABASE_URL` form matches whatever we settled on in Phase 0/2
      (no `channel_binding=require` if we stripped it).
- [ ] Deploy to production.
- [ ] In Discord Developer Portal -> General Information -> Interactions
      Endpoint URL: set to `https://<prod-domain>/api/discord`. Discord
      sends a PING; confirm the deployed handler returns PONG (200 with
      type 1). If Discord reports "PONG failed", debug the deployed
      signature verification (common cause: env var typo).
- [ ] Trigger `/api/poll` once manually:
      `curl -H "Authorization: Bearer $CRON_SECRET" https://<prod-domain>/api/poll`.
      Confirm a real incoming email becomes a card and a real Web3Forms
      recycling-request email is skipped + marked read + no card. This
      is the canonical must-pass test from plan section 14.
- [ ] Cron check:
      - If **Pro**: confirm the Vercel Cron Jobs tab shows `/api/poll`
        at `*/10 * * * *` and watch one automated tick (wait ~10 min,
        check Vercel logs).
      - If **Hobby + external scheduler**: set up the external scheduler
        (cron-job.org free tier is quickest) to hit the
        `CRON_SECRET`-guarded URL every 10 min; confirm two ticks land
        in the Vercel logs.
- [ ] README note documenting the live wiring (Interactions Endpoint
      URL, cron source, manual curl trigger).

**Review:** Adam confirms: live endpoint, PING verified in Discord portal,
one real email carded + approvable end-to-end in production, one Web3Forms
email skipped + marked read server-side, cron firing (Vercel-native or
external).
**Commit:** `phase-7: production deploy + discord interactions endpoint live`
(typically no code change — mostly config; commit any README/vercel.json
tweaks discovered during deploy here)

---

## Phase 8 — Backlog modes (cleanup of the existing unread pile)

Goal: drain `hello@`'s 60-day backlog per plan section 10, without
flooding Discord and without silently marking real email read.

Critical design note: **backlog modes do NOT touch
`email_sync_state.last_uid`.** `last_uid` is the incremental poller's
cursor (UID-anchored, going-forward). Backlog operates by DATE RANGE and
relies entirely on `message_id` dedupe for overlap safety with the
incremental path. Confirm this explicitly in code (the backlog runner does
not write `email_sync_state`).

Tasks:

- [ ] Extend `lib/poll/runner.ts` with two modes, dispatched by
      `api/poll.ts` via `?mode=`:
  - **`?mode=backlog-classify&since=YYYY-MM-DD&limit=N`**
    (since defaults to today - 60 days; cap at 60 days unless an
    explicit `since` older than that is provided AND a `?confirm=older`
    flag is set, so a typo doesn't silently process years of mail).
    - Fetch ALL messages in the date range (not UNSEEN), peek semantics
      as everywhere else.
    - Run pre-filters first (Phase 3): noise categories
      (`recycling_request`, `newsletter`, `dmarc`) marked read +
      skipped, zero token cost.
    - Classify the rest with `classifyAndDraft` into `email_queue` as
      `status='pending'`, leave UNREAD, **NO draft** (zero out
      `draft_reply` or don't call the draft step), **NO card**.
    - **Resumable batching:** process `limit` messages (default 25),
      ordered by `received_at` ascending. Track progress by the
      highest `received_at` processed in this run, returned in the
      summary as `nextSince`. To resume, the next invocation passes
      `?since=<nextSince>`. Document the resume runbook in README so
      Adam processes the backlog in chunks rather than one giant run.
    - Output summary: counts by category, skip_reason, oldest unhandled
      date, total needing attention, `nextSince` for resumption.
      Optionally post the summary once to Discord (Adam decides — open
      question #3 below).
  - **`?mode=backlog-draft&category=listing_request&since=&until=&limit=25`**
    - Selects `email_queue` rows in the chosen category with
      `status='pending'` AND `draft_reply IS NULL` within the date
      range, ordered oldest-first, capped at `limit`.
    - For each: call `draftOnly({from, subject, snippet, category})`
      (Phase 9 helper — but Phase 8 can call `classifyAndDraft` again
      with a draft-only prompt variant, simplest path) to produce the
      draft. Save to `draft_reply`. `postCard(row)`.
    - Also resumable: returns `nextSince` based on the last row
      processed so Adam can page through.
    - Does NOT mark any email read; read still happens only on
      Approve/Reject in Discord.
  - Both modes: `CRON_SECRET`-guarded, header-only.
- [ ] `message_id` dedupe guarantees backlog + incremental never
      double-process (verify with a test where the same message appears
      in both paths — second one is a no-op).
- [ ] **Filter drift check:** in the `backlog-classify` summary, if the
      `recycling_request` count is unexpectedly 0 (or jumps to way more
      than the incremental poll's typical count), print a WARNING that
      the Web3Forms subject prefix may have changed. This is the plan
      section 7a safety net made concrete.
- [ ] README: backlog runbook (run classify, page through with
      `nextSince`, review summary, run draft for chosen category, page
      through, clear cards at your pace).

**Review:** Adam runs `backlog-classify` for one chunk (limit 25), looks
at the summary (counts, oldest unhandled, drift check), runs
`backlog-draft` for `listing_request` only for one chunk, confirms noise
got marked read, real listing requests are still unread until he actions
them, nothing older than 60 days was touched, and `last_uid` in
`email_sync_state` is unchanged (verify in Neon).
**Commit:** `phase-8: backlog classify + on-demand draft modes`

---

## Phase 9 — Phase-2 optimizations + hardening

Goal: the plan's section 13 step 8 items, plus production hardening
surfaced during Phases 5-8.

Tasks:

- [ ] **Split classify/draft models:** classify call uses
      `GEMINI_CLASSIFY_MODEL` (flash-lite), draft call uses
      `GEMINI_MODEL` only when `should_reply=true`. Skips draft cost on
      the spam majority. Before flipping this on by default, re-run the
      Phase 4 `test-gemini.ts` cases with the flash-lite classify to
      confirm accuracy didn't regress (especially: listing requests
      still classify as `should_reply=true`).
- [ ] **Sent folder mirror:** implement `appendSent()` in `lib/imap.ts`
      — append the sent raw message to the IMAP `Sent` folder via
      `imapflow`'s `append` operation so outbound replies show in
      webmail. **Confirmed in Phase 0 preflight**: the folder is named
      `Sent` on PrivateEmail (listed alongside `INBOX`, `Drafts`, `Spam`,
      `Trash`).
- [ ] **Batch size bounding + timeout safety:** explicit `BATCH_LIMIT`
      env (default 25) enforced in both incremental and backlog paths.
      Track accumulated processing time in the runner; stop and return
      a partial summary (with `nextSince`) if approaching the Vercel
      `maxDuration` so a single poll never times out mid-write.
- [ ] **Multi-domain prep:** generalize mailbox config for future
      eBikeLocal/DowntownDry inboxes — an env-driven mailbox list
      (default just `hello@recycleoldtech.com`), `email_sync_state`
      already keyed by mailbox (the existing primary-key design
      supports this), and a `MAILBOX` param threaded through the
      runner. No behavior change for v1 single mailbox.
- [ ] **Alerting:** if a poll run has `errors.length > 0`, post a
      one-liner to the Discord approval channel
      ("<n> errors in poll run, see Vercel logs"). Guards against
      silent failure where errors get buried in a dashboard no one
      watches.
- [ ] **Open-items reconciliation** against plan section 15 (Gemini
      model IDs/pricing at this build time, sign-off name, claim form
      URL, Waste Advantage sender domain confirmed from a real inbox
      sample, DMARC sender confirmed). Update env / `.env.example` /
      the Gemini prompt constant if any value changes.

**Review:** Adam confirms cost drop on the spam path (compare Vercel
function logs before/after), Sent folder mirrors outbound in webmail,
multi-domain scaffolding compiles in without breaking v1 single mailbox,
alerting posts on a deliberately-injected bad row.
**Commit:** `phase-9: split classify/draft, sent folder, multi-domain prep`

---

## Cross-cutting acceptance gates (verify before declaring v1 done)

These are the plan section 14 checklist items that span phases. Confirm
all are green before v1 ship:

- [ ] Poller dedupes by Message-ID (test: trigger the same message twice
      -> one row).
- [ ] Recycling filter requires BOTH subject prefix AND web3forms sender
      (contact/partner form from web3forms does NOT skip — unit-tested
      in Phase 3, re-checked live in Phase 7).
- [ ] Noise categories marked read on sight; real email left unread
      until Discord action.
- [ ] `peek` everywhere classification happens — no accidental `\Seen`.
- [ ] Listing request gets a card, draft points to
      `https://recycleoldtech.com/claims`, does NOT ask them to email
      details back.
- [ ] Out-of-scope request gets a polite decline, no invented service.
- [ ] Spam gets no card and is NOT marked read (stays visible).
- [ ] Backlog Pass 1 marks noise read, leaves real email unread;
      `last_uid` is unchanged by backlog runs.
- [ ] Backlog selection is date-range based (60-day default), deduped
      by Message-ID, mail older than 60 days untouched.
- [ ] Approve -> recipient gets threaded reply; card updates to Sent.
- [ ] Edit -> modal prefilled; edited text is what sends.
- [ ] Reject -> no email; card updates to Skipped.
- [ ] Malformed email -> `status=error`, run continues, `last_uid` does
      not advance past it.
- [ ] Cron endpoint 401s without `CRON_SECRET` header; Discord 401s on
      bad signature.
- [ ] `CRON_SECRET` is **never** accepted via query string.
- [ ] Filter-drift warning fires in backlog-classify when
      `recycling_request` count is anomalous.

---

## Open questions to resolve WITH Adam before/during phases

Carried from plan section 15, with the phase they get answered in:

1. **Vercel cron tier.** Resolved: Adam is on **Vercel Pro**, so the
   `*/10 * * * *` cron in `vercel.json` works natively and `maxDuration:
   60` is within the Pro ceiling. No external-scheduler fallback needed.
2. **Current Gemini model IDs + pricing at build time.** Confirmed in
   Phase 4 (using `gemini-2.5-flash` for both classify and draft;
   flash-lite swap evaluated in Phase 9).
3. **Desired reply sign-off / display name.** Phase 4 (defaulting to
   `RecycleOldTech / Adam`). Confirm in Phase 4 review.
4. **Backlog inventory summary: post to Discord OR query Neon only.**
   Phase 8 (defaulting to "both: summary saved to DB + one Discord post
   per chunk"). Confirm in Phase 8 review.
5. **Waste Advantage newsletter sender domain** (plan assumes
   `wasteadvantagemag.com`) **and the DMARC report sender.** Phase 3 /
   Phase 8 — confirm by grabbing one of each from the inbox during the
   first real run; update env defaults if different.
6. **Claim form URL** is exactly `https://recycleoldtech.com/claims`.
   Phase 4 — confirm before committing the prompt; correct the path if
   it differs.