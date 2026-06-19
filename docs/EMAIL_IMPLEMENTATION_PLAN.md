# Implementation Plan: RecycleOldTech Email Triage Agent

**Goal:** A human-in-the-loop email automation that polls the PrivateEmail inbox over IMAP, classifies and drafts replies with Gemini, posts each draft to Discord with approve/edit/reject buttons, and sends only after manual approval. Designed for Claude Code to implement against the existing codebase.

**Owner:** Adam Speer / Creative Bandit LLC
**Status:** Spec for implementation. No code written yet; Claude Code generates from this.

---

## 1. Outcome

Replace manual inbox triage with a reviewable queue. Every real inquiry becomes a Discord card with a drafted reply. Nothing sends without a button tap. Emails already handled by the Make.com form automation are recognized and cleared automatically so they stop cluttering the unread count. Backlog becomes a categorized inventory you triage on your terms, with nothing important silently skipped. Backlog cleared from the phone, not a dreaded inbox.

Non-goals: fully autonomous sending, calendar handling, attachment parsing (v2), multi-domain support (v2 — design so it's easy to add eBikeLocal/DowntownDry later).

---

## 2. Architecture

```
PrivateEmail (IMAP)
  -> Poller (Vercel cron, every 10 min)
     -> fetch unprocessed messages (UID-tracked)
     -> PRE-FILTER: subject/sender match for automated-form emails
        -> match -> mark READ on server, status=skipped (automated_form), NO LLM, NO card
     -> Gemini: classify + (conditionally) draft reply
     -> upsert into Neon email_queue (status: pending)
     -> post Discord card with [Approve] [Edit] [Reject]
  -> User taps a button
     -> Discord interaction -> /api/discord handler
        -> Approve: send via PrivateEmail SMTP, status=sent, edit card
        -> Edit: modal prefilled with draft -> save -> send
        -> Reject: status=rejected, edit card
```

Two serverless endpoints + Neon (Postgres) as the shared store.

---

## 3. Stack decisions (locked)

- **Runtime/host:** Standalone Vercel serverless functions + Vercel Cron, in a **dedicated new repo** (no framework). Chosen over Astro API routes: this is an unattended background service (poller + webhook handler) with no UI, so it should be isolated from the revenue sites (eBikeLocal, etc.) in its own repo/project, decoupling its deploys and failures from them. Astro would only earn its place if an admin UI (web dashboard for the queue) is wanted later; until then, Discord + occasional Neon queries suffice. See "Alternatives considered" (section 3a).
- **DB:** Neon (Postgres). Recommended over Supabase here: this agent uses only plain tables (no Auth/Realtime/Storage/RLS), so there's no Supabase dependency, and Adam already runs eBikeLocal and YieldToFreedom on Neon for free vs $35/mo Supabase. Connect with `@neondatabase/serverless` (HTTP driver, ideal for Vercel's connection-per-invocation model) + Drizzle ORM (consistent with YieldToFreedom). Plain `pg` also works. Nothing in this plan requires Supabase; it can run on either, but Neon is the default.
- **LLM:** Gemini 2.5 Flash for classify + draft. Documented option to route the classify step to Gemini 2.5 Flash-Lite to cut cost once accuracy is confirmed. Single Google AI API key.
- **Email in:** `imapflow` (IMAP) + `mailparser`.
- **Email out:** `nodemailer` over PrivateEmail SMTP.
- **Notifications/approval:** Discord bot + interactions endpoint (Ed25519 signature verification).

> **ACTION for implementer:** confirm current Gemini pricing and model IDs before finalizing (rates and model names shift). At plan time the target model is `gemini-2.5-flash`.

---

## 3a. Alternatives considered (why Vercel functions, not Make/n8n/Astro)

- **Make.com:** rejected for this job. Adam already uses it for the recycling-form automation (a clean fire-and-forward flow that belongs there), but this triage agent is operation-hungry (multi-module per email + approval round-trip) and Adam is near the free-tier ceiling. Make also handles the human-in-the-loop *pause* poorly: it would split into two disconnected scenarios with the draft parked between them, i.e. the same two-function shape as the Vercel design but metered per operation and with less control over IMAP/SMTP threading.
- **n8n (self-hosted):** legitimate runner-up. Free/unmetered if self-hosted, better wait-for-webhook support than Make. Rejected because: (a) the no-code advantage is near-neutral for a senior full-stack dev, (b) it adds a service to host/patch/monitor/back up, (c) the custom bits (UID tracking, In-Reply-To/References threading, Web3Forms subject-prefix filter, two-pass backlog) are easier to get exact in code, and (d) Claude Code generates the code anyway, erasing n8n's labor-saving edge.
- **Astro API routes:** viable (matches the directory stack) but this service has no UI, and co-locating it in a revenue-site repo couples deploys. A dedicated Astro project would buy little over plain functions. Revisit only if an admin dashboard is wanted later.

**Decision:** standalone Vercel functions for this specific unattended, code-heavy, isolation-wanting job. Keep the recycling-form flow in Make.

---

## 3b. Provisioning checklist (Adam does these; no code required)

Repo & infra are NEW and DEDICATED (isolation from revenue sites):

**Neon**
- [ ] Create a NEW Neon project (e.g. `recycleoldtech-email-agent`). (New project recommended over a new DB inside an existing project, to match the dedicated-repo isolation. Neon free tier allows multiple projects.)
- [ ] Copy the **pooled** connection string -> `DATABASE_URL`.

**GitHub + Vercel**
- [ ] Create a NEW empty GitHub repo (e.g. `roi-email-agent`).
- [ ] Create a NEW Vercel project linked to it (connect after scaffolding).

**PrivateEmail**
- [x] Mailbox to monitor: **`hello@recycleoldtech.com`** (the only active website mailbox).
- [ ] Mailbox password ready -> `EMAIL_PASS`.

**Google AI (Gemini)**
- [ ] API key from Google AI Studio -> `GEMINI_API_KEY` (can reuse the Make.com one).

**Discord**
- [ ] Create app at discord.com/developers.
- [ ] Add Bot -> copy Bot Token -> `DISCORD_BOT_TOKEN`.
- [ ] Copy Application Public Key -> `DISCORD_PUBLIC_KEY`.
- [ ] Create/choose approval channel, Developer Mode on, Copy ID -> `DISCORD_CHANNEL_ID`.
- [ ] Interactions Endpoint URL: set AFTER deploy (points at live `/api/discord`).

**Self-generated**
- [ ] Random long string -> `CRON_SECRET`.

Only hard blocker before build: the mailbox. Everything else can be provisioned in parallel.

---

## 4. Connection facts

**PrivateEmail (Namecheap):**
- IMAP host `mail.privateemail.com`, port `993`, SSL.
- SMTP host `mail.privateemail.com`, port `465`, SSL.
- Auth: full email address + mailbox password.

**Discord:**
- Create app at discord.com/developers -> add Bot -> copy Bot Token.
- Copy Application Public Key (for signature verification).
- Target channel ID for posting cards.
- Set Interactions Endpoint URL to the deployed `/api/discord` route.

---

## 5. Environment variables

```
# PrivateEmail
EMAIL_IMAP_HOST=mail.privateemail.com
EMAIL_IMAP_PORT=993
EMAIL_SMTP_HOST=mail.privateemail.com
EMAIL_SMTP_PORT=465
EMAIL_USER=hello@recycleoldtech.com      # the only active website mailbox
EMAIL_PASS=

# Gemini
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash
GEMINI_CLASSIFY_MODEL=gemini-2.5-flash    # swap to flash-lite later

# Neon (Postgres)
DATABASE_URL=                              # Neon connection string (pooled), server-side only

# Discord
DISCORD_BOT_TOKEN=
DISCORD_PUBLIC_KEY=
DISCORD_CHANNEL_ID=

# Auth for cron endpoint
CRON_SECRET=

# === Deterministic pre-filters (run BEFORE any LLM call) ===
# These cover the known, recurring skip categories. Each is matched
# case-insensitively. See section 7a for the matching logic and the
# subject-AND-sender safety rule for shared-inbox forms.

# 1. Recycling request (already handled by Make.com via Web3Forms).
# City varies per submission ("Recycling request from Surprise, Arizona"),
# so match the stable PREFIX only, AND require the Web3Forms sender.
AUTOMATED_FORM_SUBJECTS=Recycling request from
AUTOMATED_FORM_FROM=notify@web3forms.com
AUTOMATED_FORM_BODY_MARKER=
AUTOMATED_FORM_MARK_READ=true

# 2. Waste Advantage newsletter -> mark read, skip.
NEWSLETTER_FROM=wasteadvantagemag.com
NEWSLETTER_SUBJECTS=
NEWSLETTER_MARK_READ=true

# 3. DMARC aggregate reports -> mark read, skip.
DMARC_SUBJECTS=Report domain:,Report Domain:
DMARC_FROM=
DMARC_MARK_READ=true

# NOTE: spam is intentionally NOT a deterministic pre-filter and is NOT
# auto-marked-read. It is classified by the LLM and merely left undrafted,
# so a false positive (e.g. a cold but legitimate listing request) is never
# silently hidden. See section 9.
```

---

## 6. Database schema

```sql
create table email_queue (
  id uuid primary key default gen_random_uuid(),
  message_id text unique not null,        -- IMAP Message-ID header; dedupe key
  imap_uid integer,                       -- for UID-based incremental fetch
  from_addr text not null,
  from_name text,
  subject text,
  body_snippet text,                      -- first ~2k chars, cleaned
  category text,                          -- recycling_request|newsletter|dmarc|spam|listing_request|partner_inquiry|support|claim|out_of_scope|other
  should_reply boolean default false,
  draft_reply text,
  status text default 'pending',          -- pending|approved|rejected|sent|skipped|error
  skip_reason text,                       -- e.g. 'automated_form_subject_match', 'backlog_cutoff'
  discord_message_id text,
  in_reply_to text,                       -- original Message-ID for threading
  email_references text,                  -- References header chain
  error_detail text,
  received_at timestamptz,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- track last processed UID per mailbox so the poller is incremental
create table email_sync_state (
  mailbox text primary key,               -- e.g. 'hello@recycleoldtech.com/INBOX'
  last_uid integer default 0,
  updated_at timestamptz default now()
);

create index on email_queue (status);
create index on email_queue (received_at);
```

Access: the `DATABASE_URL` is server-side only (never exposed to the client). All reads/writes happen inside the Vercel functions. No public/anon connection. (Neon has no RLS layer like Supabase; security here is simply that the connection string stays in server env vars.)

---

## 7. Component 1 — Poller (`/api/poll`)

Triggered by Vercel cron. Guard with `CRON_SECRET` (check header or query against env; reject otherwise).

**Read/unread capability (explicit):** the poller can set the IMAP `\Seen` flag (mark read) and read messages regardless of their current read state, both standard `imapflow` operations on PrivateEmail. Marking read is applied ONLY per the rules below: deterministic noise categories are marked read on sight; real email is left unread until Adam actions it. Reading/classifying a message does NOT by itself mark it read (fetch with the peek option so inspection doesn't set `\Seen`).

Steps:
1. Read `last_uid` from `email_sync_state` for this mailbox.
2. Connect with `imapflow`, open `INBOX`, fetch messages with UID > `last_uid` (incremental). For the initial backlog run, see section 10.
3. For each message:
   a. Parse with `mailparser` -> from, subject, text body, Message-ID, References.
   b. Dedupe: skip if `message_id` already in `email_queue`.
   c. **DETERMINISTIC PRE-FILTERS (before any LLM call)** — see section 7a. Check the message against the recycling-request, newsletter, and DMARC rules in order. On any match: mark it `\Seen` on the IMAP server (if that filter's `*_MARK_READ` is true), insert row as `status='skipped'` with the matching category (`recycling_request`|`newsletter`|`dmarc`) and a `skip_reason`, no Gemini call, no Discord card. Continue to next message.
   d. Clean body: strip signatures/quoted history to a ~2k-char snippet for the LLM.
   e. Call Gemini classify+draft (section 9).
   f. Upsert row as `status='pending'` with category, should_reply, draft_reply, threading headers.
   g. Routing: if `should_reply` is true, post Discord card (section 8) and store `discord_message_id`. If category is `spam` (LLM-detected), store `status='skipped'` but do NOT mark read and do NOT post a card (it stays unread/visible in webmail as a safety net). Other no-reply categories: store `status='skipped'`, no card.
4. Update `email_sync_state.last_uid` to the highest UID processed.
5. Return a summary count.

Reliability: wrap per-message processing in try/catch so one bad email doesn't kill the run; on failure set `status='error'` + `error_detail` and continue. Do NOT advance `last_uid` past a message that failed to persist.

---

## 7a. Deterministic pre-filters (skip the known recurring noise before any LLM call)

Adam's inbox (`hello@recycleoldtech.com`, the single shared mailbox) breaks into five real categories. Four are handled cheaply/deterministically; the fifth is the LLM's job (section 9).

| # | Category | Signal | Action |
|---|----------|--------|--------|
| 1 | Recycling request | subject prefix `Recycling request from` AND sender `notify@web3forms.com` | mark read, skip (already handled by Make.com) |
| 2 | Waste Advantage newsletter | sender domain `wasteadvantagemag.com` | mark read, skip |
| 3 | DMARC report | subject contains `Report domain:` (optionally + aggregator sender) | mark read, skip |
| 4 | Spam | LLM-detected (section 9) | skip drafting, do NOT mark read, no card |
| 5 | Everything else | LLM classify + draft | Discord card if reply-worthy |

Categories 1-3 run here as deterministic pre-filters (no tokens spent). This drains the bulk of recurring noise for free.

Logic (runs in the poller, before any LLM call), checked in order:

1. **Recycling request:** subject contains any `AUTOMATED_FORM_SUBJECTS` entry (case-insensitive) **AND** sender contains `AUTOMATED_FORM_FROM`. Both required. On match -> mark `\Seen` (if `AUTOMATED_FORM_MARK_READ`), row `status='skipped'`, `category='recycling_request'`, `skip_reason='recycling_form_make_handled'`.
2. **Newsletter:** sender contains `NEWSLETTER_FROM` (or subject matches a `NEWSLETTER_SUBJECTS` entry, if set). On match -> mark read (if `NEWSLETTER_MARK_READ`), `category='newsletter'`, `skip_reason='newsletter'`.
3. **DMARC:** subject contains any `DMARC_SUBJECTS` entry (and sender contains `DMARC_FROM` if set). On match -> mark read (if `DMARC_MARK_READ`), `category='dmarc'`, `skip_reason='dmarc_report'`.

For all matches: insert/upsert the `email_queue` row, store from/subject/received_at for audit, do NOT call Gemini, do NOT post to Discord, continue to next message.

**Safety nets:**
- Every skip is a DB status, never a deletion. Everything stays queryable.
- The poll run summary reports per-category skip counts. If `recycling_request` unexpectedly drops to zero, the Web3Forms subject may have changed and the filter needs updating, so nothing silently slips past.
- Filters are configured entirely in env (not hardcoded), so Adam adjusts them without a redeploy.

**Shared-inbox caution (critical):** `hello@` is the ONLY mailbox, so every form submission and all human email land here together. The recycling-request filter therefore matches subject prefix AND the Web3Forms sender, never sender alone, because other forms (contact, partner inquiry) would ALSO arrive from `notify@web3forms.com`. Any Web3Forms email whose subject is NOT `Recycling request from...` falls through to LLM classification and still surfaces as a card. Before go-live, confirm no other active form produces a subject starting with "Recycling request from".

---

## 8. Component 2 — Discord card + interaction handler (`/api/discord`)

**Posting a card (from poller):** use the Bot Token to POST a channel message with an embed (From, Subject, Category, and the draft reply in a code block or quote) and an action row of 3 buttons. Encode the `email_queue.id` in each button's `custom_id`, e.g. `approve:<id>`, `edit:<id>`, `reject:<id>`.

**Handler endpoint (`/api/discord`):**
1. Verify the Ed25519 signature using `DISCORD_PUBLIC_KEY` and the `X-Signature-Ed25519` / `X-Signature-Timestamp` headers. Reject (401) if invalid. Respond to Discord PING (type 1) with PONG.
2. Parse `custom_id` -> action + queue id.
3. **Approve:** load row -> send email (section 11) -> set `status='sent'` -> edit the original Discord message to show "✅ Sent" and remove buttons.
4. **Reject:** set `status='rejected'` -> edit message to "🗑 Skipped", remove buttons.
5. **Edit:** respond with a Discord modal (type 9) containing a text input prefilled with `draft_reply`. On modal submit (separate interaction), save edited text to `draft_reply`, send the email, set `status='sent'`, edit card to "✅ Sent (edited)".

Acknowledge within Discord's 3-second window: defer if sending takes longer (respond type 5, then patch the response after SMTP completes).

---

## 9. Gemini classify + draft (category 5: "everything else")

Only emails that pass all deterministic pre-filters reach Gemini. The model's job is to separate reply-worthy human email from spam/junk, and to draft a reply when warranted.

Single call per email returning strict JSON. Prompt sketch:

```
System: You are the email assistant for RecycleOldTech.com. You triage inbound
email and draft replies AS RecycleOldTech, in Adam's voice (friendly,
professional, concise, no em dashes).

=== ABOUT RECYCLEOLDTECH (use this to draft accurately) ===
What we ARE: an online directory that helps people responsibly recycle old
electronics and e-waste. Specifically, we:
- List/catalog local e-waste recycling businesses across the US.
- Help consumers find where to recycle old tech near them.
- Connect users with local recyclers.
- Offer a paid "Verified Partner" program for recyclers who want an enhanced,
  claimed listing.

What we are NOT (do NOT imply we offer these; politely decline):
- We do NOT buy or sell used computers, parts, or electronics.
- We do NOT repair devices.
- We do NOT physically pick up, haul, or process e-waste ourselves (the
  recyclers we list do that; we are the directory that points people to them).
- We do NOT provide data-destruction services ourselves.

=== HOW TO ROUTE EACH INQUIRY (what the draft should DRIVE TOWARD) ===
- A recycler wanting to be listed -> give a brief, warm welcome AND direct them
  to our claim form at https://recycleoldtech.com/claims to submit their
  details there (this captures structured data; do NOT ask them to email
  details back). You may lightly mention that a free listing is available and
  that we also offer an optional Verified Partner upgrade, without hard-selling.
- Someone asking how/where to recycle something -> point them to the site to
  search their location; be genuinely helpful.
- A request for something we do NOT do (buying/selling parts, repair, pickup,
  data destruction) -> a polite, honest reply that this is not a service we
  offer (yet), kept short and kind. Do not invent a service or over-promise.
- Verified Partner / advertising / collaboration questions -> helpful reply;
  these are warm business leads.

Classify the email and, if it warrants a human reply, draft that reply.

REPLY-WORTHY (should_reply = true). These are the emails Adam cares about:
- listing_request: a recycling/e-waste business asking to be added to the
  directory ("please list us", "add us as a resource", "can you include our
  company"). HIGHEST VALUE -- free inventory growth and a possible Verified
  Partner lead. Draft a brief warm welcome that points them to
  https://recycleoldtech.com/claims to submit their listing via the form.
  Lightly note the optional Verified Partner upgrade; do not hard-sell.
- partner_inquiry: questions about the Verified Partner / claimed-listing
  program, advertising, or business collaboration.
- support: a genuine person asking how/where to recycle something, or about an
  existing listing.
- claim: someone claiming or correcting their business listing.
- out_of_scope: a real person/business asking for something we do NOT offer
  (buying/selling used computers or parts, repair, pickup/hauling, data
  destruction). should_reply = true, but the draft is a short, polite, honest
  "that's not a service we offer (yet)" reply. Do NOT imply we provide it.

NOT reply-worthy (should_reply = false):
- spam: cold sales pitches aimed AT us (SEO services, link building, web design,
  "boost your traffic"), mass outreach, irrelevant solicitations.
- other: newsletters/notifications that slipped the pre-filters, anything
  ambiguous or not needing a response.

IMPORTANT: an unsolicited cold email from a stranger is NOT automatically spam.
A genuine e-waste business asking to be listed (even if cold) is a
listing_request and IS reply-worthy. Judge by intent and relevance to an
e-waste directory, not by whether it was solicited.

Return ONLY JSON, no markdown fences:
{
  "category": "listing_request|partner_inquiry|support|claim|out_of_scope|spam|other",
  "should_reply": true|false,
  "draft_reply": "string or empty",
  "reason": "one short phrase on why"
}

Email:
From: {from}
Subject: {subject}
Body: {snippet}
```

Reference examples (the system must get these right):
> 1. Subject: "Please list us." From a Southern Maine e-waste & data-destruction
>    business owner asking to be added as a local recycling resource, with their
>    website and services. -> category `listing_request`, should_reply `true`.
>    Draft: brief warm welcome + point them to https://recycleoldtech.com/claims
>    to submit their listing via the form (do NOT ask them to email details);
>    lightly mention the optional Verified Partner upgrade.
> 2. Subject: "Selling 200 used laptops" or "Do you buy old computers?" -> a real
>    person wanting to sell/buy hardware. category `out_of_scope`, should_reply
>    `true`. Draft: short, polite note that buying/selling isn't a service we
>    offer; we're a directory that helps people find local recyclers. No
>    over-promising, no invented service.

Implementer notes:
- Parse defensively: strip accidental ``` fences before JSON.parse; on parse failure, set category=other, should_reply=false, log raw.
- Keep the draft short; Adam approves/edits in Discord.
- Voice guidance: no em dashes (house style). Sign-off as RecycleOldTech / Adam.
- **Spam handling:** spam is skipped from drafting but NOT marked read and NOT carded; it stays visible in webmail. Rationale: a false-positive spam tag on a real listing_request would silently lose a high-value lead, so err toward letting borderline mail remain visible rather than hiding it.
- Cost optimization (phase 2): call `GEMINI_CLASSIFY_MODEL` (flash-lite) for category+should_reply first; only call full Flash for the draft when should_reply is true. Skips draft cost on the spam majority.

---

## 10. Backlog cleanup (one-time, triage-first so nothing important is missed)

There is a large existing unread pile in `hello@`. Drain it without flooding Discord, without sending anything unattended, and WITHOUT silently marking real email read before Adam has handled it. Read-flag behavior during backlog is deliberate and differs by category (see the rule below).

**Selection mode for the first cleanup:** fetch by a **bounded date range, ALL messages** (last **60 days** max, per Adam, anything older is not worth triaging), NOT by `UNSEEN` alone. Reason: once an inbox has been manually picked at, "unread" is an unreliable signal of "needs attention", some important emails may already have been opened (and are thus `\Seen`) but never actually handled. A 60-day range catches those; Message-ID dedupe prevents double-processing. Default the window to 60 days; keep it overridable via `?since=YYYY-MM-DD` but do not exceed 60 days without explicit intent. Mail older than 60 days is left untouched.

**Read-flag rule during backlog (important):**
- Recurring noise (recycling_request / newsletter / dmarc) -> marked `\Seen` immediately. This alone will dramatically cut the unread count.
- Everything else (listing_request, support, out_of_scope, partner_inquiry, claim, spam, other) -> **left UNREAD** during Pass 1. It is only marked read later, when Adam actually actions it (approve/reject) in Discord. This preserves the unread count as a "not yet handled" signal until Adam trusts the system.

**Pass 1 — classify-only inventory (no drafts, no cards):**
- Manual mode on the poller: `?mode=backlog-classify&since=YYYY-MM-DD&limit=N` (since defaults to today minus 60 days), CRON_SECRET-guarded.
- Fetch the date range in rate-limited batches (e.g. 25 per chunk, short sleep between Gemini calls).
- Run deterministic pre-filters (section 7a) first: noise categories marked read + skipped, zero token cost.
- Classify the rest into `email_queue` as `status='pending'`, leave unread, DO NOT draft, DO NOT post cards.
- Output a summary: counts by category, oldest unhandled date, total needing attention. Optionally post once to Discord.

**Review:** query the inventory (or read the summary). You now see exactly what's sitting there, grouped, with the junk already cleared from the unread count and the real email still flagged unread.

**Pass 2 — draft on demand:**
- Trigger drafting only for the categories and/or date range you choose: `?mode=backlog-draft&category=listing_request` (etc.).
- Those become Discord cards; clear them at your pace. Approve/edit/reject -> the email is sent (if applicable) and marked read at that point.

**Key guarantees:** no automatic time-based deletion of visibility; real email stays unread until you handle it; every skip is a reversible DB status, not a deletion. Choosing not to draft a category is your explicit decision.

**Going-forward (after backlog is drained):** normal incremental polling uses UID tracking (section 7), independent of read/unread status, so manually opening an email in webmail never causes the poller to skip it.

---

## 11. Sending (SMTP)

- `nodemailer` transport: PrivateEmail SMTP, port 465, secure true, auth EMAIL_USER/EMAIL_PASS.
- Set `inReplyTo` and `references` from the stored headers so replies thread correctly in the recipient's client.
- `from` = EMAIL_USER (display name "RecycleOldTech" / "Adam at RecycleOldTech").
- After send: optionally append the sent message to the IMAP `Sent` folder via imapflow so it shows in webmail. (Nice-to-have; flag if skipped.)

---

## 12. Vercel config

`vercel.json`:
```json
{ "crons": [{ "path": "/api/poll", "schedule": "*/10 * * * *" }] }
```
- Cron hits `/api/poll`; endpoint checks `CRON_SECRET`.
- Confirm function timeout is enough for a batch (raise maxDuration if needed). Keep per-run batch size bounded so it finishes inside the limit.

---

## 13. Build order for Claude Code

1. Scaffold the dedicated repo: `package.json`, `vercel.json`, `tsconfig`, `lib/`, `api/`, Drizzle config + schema. No framework.
2. Neon migration: define via Drizzle schema + push (or run the SQL in section 6).
3. Shared lib: Neon/Drizzle client, Gemini client+prompt, IMAP fetch util (incl. mark-as-read), SMTP sender, Discord REST helpers (post message, edit message, verify signature, modal), automated-form matcher (section 7a).
4. `/api/poll` with pre-filter wired in BEFORE the LLM call (incremental UNSEEN/UID path first).
5. `/api/discord` (PING + signature, then approve/reject, then edit modal).
6. Deploy to Vercel, then set the Discord Interactions Endpoint URL to the deployed handler; test with one real email AND one real automated-form email (confirm the form email is skipped + marked read, no card).
7. Add backlog modes: `backlog-classify` (inventory) then `backlog-draft` (on demand).
8. Phase-2: split classify/draft models; append to Sent folder; generalize mailbox config for multi-domain.

---

## 14. Test checklist

- [ ] Poller dedupes (same email twice -> one row).
- [ ] Recycling request (subject prefix + web3forms sender) -> skipped, marked read, NO LLM call, NO card.
- [ ] Recycling filter requires BOTH signals (web3forms sender + DIFFERENT subject, e.g. a contact form -> NOT skipped as recycling; falls through to LLM).
- [ ] Waste Advantage newsletter -> skipped, marked read, no card.
- [ ] DMARC report ("Report domain:") -> skipped, marked read, no card.
- [ ] Per-category skip counts appear in the run summary.
- [ ] **Listing request (Ron Kramer "Please list us" type) -> category listing_request, should_reply true, draft points to https://recycleoldtech.com/claims with a brief welcome. This is the canonical must-pass case.**
- [ ] Listing draft does NOT ask them to email details back (it routes to the form).
- [ ] Out-of-scope request (e.g. "do you buy used laptops?") -> category out_of_scope, polite decline draft, does NOT imply we offer the service.
- [ ] Cold sales pitch AT us (SEO/web design spam) -> spam, no card, NOT marked read (stays visible).
- [ ] Genuine "how do I recycle X" -> support, card with helpful draft.
- [ ] Backlog classify pass -> inventory counts produced, no cards, no drafts.
- [ ] Backlog draft pass -> only chosen category/date becomes cards.
- [ ] Backlog Pass 1: noise (recycling/newsletter/dmarc) marked read; real email (listing/support/etc.) left UNREAD.
- [ ] Classifying an email does NOT mark it read (fetch uses peek; no accidental \Seen).
- [ ] Real email is marked read ONLY after Adam approves/rejects it in Discord.
- [ ] Backlog selects by date range (ALL messages, last 60 days, default), catching already-opened-but-unhandled email, deduped by Message-ID; mail older than 60 days untouched.
- [ ] Approve -> recipient gets threaded reply; card shows Sent.
- [ ] Edit -> modal prefilled; edited text is what sends.
- [ ] Reject -> no email; card shows Skipped.
- [ ] Bad/malformed email -> status=error, run continues.
- [ ] Cron endpoint rejects requests without CRON_SECRET.
- [ ] Discord handler rejects bad signatures.
- [ ] last_uid advances only past successfully persisted messages.

---

## 15. Open items for Adam to confirm

1. ~~Astro API routes vs standalone Vercel functions~~ **RESOLVED:** standalone Vercel functions, dedicated repo (section 3a).
2. ~~Exact mailbox to monitor~~ **RESOLVED:** `hello@recycleoldtech.com` (sole active website mailbox).
3. ~~Exact subject/sender of automated form emails~~ **RESOLVED:** subject prefix `Recycling request from`, sender `notify@web3forms.com` (Web3Forms). Confirm no OTHER active form produces a subject starting with "Recycling request from".
4. Confirm current Gemini model IDs + pricing at build time.
5. Desired reply sign-off / display name.
6. Whether to post the backlog inventory summary to Discord or just query Neon directly.
7. New Neon project vs new DB in an existing project (plan recommends new project).
8. Confirm the exact Waste Advantage newsletter sender domain (plan assumes `wasteadvantagemag.com`) and the DMARC report sender, by grabbing one of each from the inbox.
9. Confirm the claim form URL (plan assumes `https://recycleoldtech.com/claims`). Correct the path if it differs.
