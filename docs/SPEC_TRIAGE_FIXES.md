# Spec — Triage agent fixes (mark-as-read, contact-form recycling requests, hardening)

Status: **approved by Adam 2026-08-07** — decisions recorded in §6, implementation in progress.
Written: 2026-08-07. Author: investigation pass over the live system.
Related: [`ACTION_PLAN.md`](ACTION_PLAN.md), [`EMAIL_IMPLEMENTATION_PLAN.md`](EMAIL_IMPLEMENTATION_PLAN.md).

This document covers three asks:

1. **Part 1** — unread mail is piling up in webmail even though the poller is
   supposed to mark processed noise as read. Root cause found and proven.
2. **Part 2** — people who send recycling help requests to the generic
   **contact form** (instead of the city-page recycling form) need a reply that
   routes them to the right form, or invites them to reply with details.
3. **Part 3** — other problems in the current logic/methodology, ranked, with
   recommendations.

---

## 0. How this was investigated (evidence base)

Everything below was verified against the live system on 2026-08-07, not
inferred from reading code alone:

| Check | Result |
| --- | --- |
| `email_queue` breakdown by status/category/skip_reason | 819 rows, 2025-07-02 → 2026-08-07 |
| `email_sync_state` cursor | `hello@recycleoldtech.com/INBOX` → `last_uid = 1439` (caught up) |
| IMAP `INBOX` status | 1434 messages, **282 unseen** (unseen UID range 1116–1439) |
| Every unread UID joined against `email_queue` | **282 of 282 already have a row** — nothing is unprocessed |
| Nested `getMailboxLock` probe on a live connection | nested write lock **never granted** while a read-only lock is held (`LockTimeout` after 5s with an explicit timeout; `markSeen` passes none) |
| Raw headers of a Web3Forms notification | `From: notify@web3forms.com`, **`Reply-To: <the actual submitter>`** |
| `https://www.recycleoldtech.com/api/cities-data` | HTTP 200, 4,457 city/state pairs with `url`, 494 with coordinates |
| City page + form anchor (`/states/pennsylvania/greencastle`) | HTTP 200, contains `id="recycling-request-form"` |
| Gemini `gemini-2.5-flash` classify+draft round trip | works today (one historical row shows a hard 404 on this model id — see 3.9) |

---

## Part 1 — Unread mail is not being marked read

### 1.1 What Adam sees

282 unread messages in `hello@recycleoldtech.com`. Broken down by the DB row
that already exists for each of those unread messages:

| status | category | skip_reason | count | Should it be read? |
| --- | --- | --- | --- | --- |
| skipped | recycling_request | recycling_form_make_handled | **120** | **YES — bug** |
| skipped | dmarc | dmarc_report | **83** | **YES — bug** |
| skipped | newsletter | newsletter | **28** | **YES — bug** |
| skipped | other | category:other:no_reply | 31 | By design (reconsider — see 1.4) |
| skipped | spam | spam | 17 | By design (reconsider — see 1.4) |
| skipped | support | category:support:no_reply | 1 | By design |
| error | support / (none) | – | 2 | By design (needs attention, see 3.9) |

So **231 of the 282** are pre-filter matches whose config explicitly says to
mark them read (`AUTOMATED_FORM_MARK_READ=true`, `NEWSLETTER_MARK_READ=true`,
`DMARC_MARK_READ=true`), and they were not marked read. The remaining 51 are
left unread deliberately by the current routing policy.

Note the unread UIDs start at 1116, not at 1. Everything below 1116 is read
because `npm run mark:read` (`scripts/mark-all-read.ts`) was run manually at
some point. That manual sweep is what has been masking this bug.

### 1.2 Root cause: an IMAP mailbox-lock deadlock

`markSeen()` has **never** succeeded from the poller. It cannot.

- `lib/imap.ts:170` — `fetchSinceUid()` acquires a mailbox lock with
  `client.getMailboxLock(mailbox, { readOnly: true })` and holds it for the
  entire lifetime of the async generator (`finally { lock.release() }` only
  runs when the generator completes).
- `lib/imap.ts:261` — `markSeen()` acquires `getMailboxLock(mailbox, { readOnly: false })`
  **on the same client**.
- `lib/poll/runner.ts:212` and `:365` call `markSeen(client, mailbox, uid)`
  from inside the `for await` loop over that generator — i.e. while the
  read-only lock is still held.

ImapFlow's lock is a strict per-connection mutex. From
`node_modules/imapflow/lib/imap-flow.js`:

> `// Mutex invariant: at most one lock may be held at a time.`

and the public docs for `getMailboxLock`:

> *"next `getMailboxLock()` call is not executed until previous one is released."*

`markSeen()` passes no `acquireTimeout`, so the inner request waits forever for
a lock that cannot be released until the loop it is blocking finishes.
**Classic deadlock.** Verified live: with a read-only lock held, a nested write
lock request on the same client was still unfulfilled after 5 seconds and only
terminated because the probe supplied an explicit timeout.

The comments in the code assert the opposite and are wrong:

- `lib/poll/runner.ts:133-134` — *"We re-enter read/write locks per-operation
  inside markSeen; reusing one connection across UIDs is fine since
  getMailboxLock is per-call."*
- `api/poll.ts:84` — *"the runner closes the IMAP read-only lock and re-opens
  for markSeen"* — it does not close it.

**Why the poller still appears to work:** `baseOptions()` sets
`socketTimeout: 30_000` (`lib/imap.ts`). During the deadlock there is no socket
traffic, so after 30s ImapFlow tears the connection down, which rejects all
queued locks. `markSeen` then throws, gets swallowed into
`summary.errors[stage='markseen']`, the now-dead connection makes the rest of
the batch fail, `api/poll.ts` catches it, and the cursor still advances to
`summary.highestPersistedUid`. Net effect: **rows get written, cards get
posted, the cursor moves — and not a single message ever gets flagged read.**
Each affected poll run also burns ~30s of function time doing nothing.

Approve/Reject/Edit in Discord are *not* affected: `api/discord.ts:241`, `:315`,
`:435` each open a **fresh** `withImap()` connection with no outer lock held, so
those `markSeen` calls do work. That matches the data — every `sent` and
`rejected` row is read.

### 1.3 Fix: never nest locks on the fetch connection

Recommended approach — **collect UIDs during the loop, flag them in one batch
after the generator is exhausted.** This also removes 1 IMAP round trip per
message.

1. Add to `lib/imap.ts`:
   ```ts
   /** Flag many UIDs \Seen in one command. Must NOT be called while another
    *  mailbox lock is held on the same client (ImapFlow locks are a strict
    *  per-connection mutex — see markSeen's doc comment). */
   export async function markSeenBatch(
     client: ImapFlow, mailbox: string, uids: number[],
   ): Promise<void>
   ```
   It takes its own lock, calls `client.messageFlagsAdd(uids.join(','), ['\\Seen'], { uid: true })`
   once, releases. Chunk at 500 UIDs like `scripts/mark-all-read.ts` already does.
2. Change `RoutingDecision.markRead` handling in `lib/poll/runner.ts`: instead
   of calling `markSeen` inline, push `msg.uid` onto a `pendingSeen: number[]`
   carried on the `RunSummary` (or returned from `runBatch`).
3. `runBatch()` returns `{ highestPersistedUid, seenUids }` after the `for await`
   completes (generator done → lock released).
4. `api/poll.ts` calls `markSeenBatch(client, mailbox, seenUids)` **after**
   `runBatch` returns, still inside the same `withImap` scope. Record a
   `stage:'markseen'` error on failure; do not fail the run.
5. Add `acquireTimeout: 15_000` to both `getMailboxLock` calls in
   `lib/imap.ts` as a **guard rail**, so any future accidental nesting fails
   loudly in seconds instead of silently burning 30s and killing the
   connection.
6. Fix the three lying comments (`lib/poll/runner.ts:133`, `api/poll.ts:84`,
   and `markSeen`'s own doc block) and state the mutex constraint explicitly.

**Regression test** (this is the test the current suite is missing — the whole
bug class is "two locks on one connection", which no unit test can see because
`lib/poll/runner.test.ts` stubs IMAP): add an integration-style test with a
fake `ImapFlow` whose `getMailboxLock` enforces the real mutex (second call
never resolves while one is held). Under that fake, today's code hangs and the
fixed code passes.

### 1.4 Decisions Adam needs to make on the *by design* unread

Independent of the bug, 51 unread messages are unread on purpose. Options:

| Bucket | Now | Recommendation |
| --- | --- | --- |
| `spam` (17) | left unread as a "safety net" so it stays visible | **Mark read.** 80 spam rows total and zero have ever needed action. Every one is in the DB and queryable. Leaving them unread makes the unread badge meaningless, which is the real safety risk. Gate on a new `SPAM_MARK_READ` env (default `true`). |
| `other` (31) | left unread | **Mark read**, gated on `OTHER_MARK_READ` (default `true`). Note 25 of the `other` rows are `MAILER-DAEMON` bounces — see 3.6, they deserve their own handling. |
| `error` (2) | left unread | **Keep unread**, and add the Phase 9 alerting so they surface actively rather than sitting in a pile. |
| `pending` awaiting a Discord decision | left unread | **Keep unread.** This is the one bucket where unread is genuinely meaningful. |

Target steady state: **unread count == number of open Discord cards + error
rows.** That makes the inbox badge a real signal again.

### 1.5 One-time cleanup

After the fix ships, drain the existing 231-message pile. Do **not** just run
`npm run mark:read` — that marks the pending cards read too. Add
`scripts/reconcile-seen.ts`:

- Query `email_queue` for rows where the routing decision says "should be
  read" (`skip_reason` in the pre-filter set, plus spam/other if 1.4 is
  accepted) and whose `imap_uid` is in the IMAP unseen set.
- Print the count and the category breakdown, require typed `yes` (same guard
  pattern as `mark-all-read.ts`), then `markSeenBatch` them.
- Leave `pending`/`error` rows untouched.

---

## Part 2 — Recycling help requests that arrive via the generic contact form

### 2.1 The situation

Two Web3Forms forms feed the same mailbox:

| Form | Web3Forms key | Subject | Handled by |
| --- | --- | --- | --- |
| City-page recycling form (`src/components/RecyclingRequestForm.astro` in `ewaste-dir`) | `e1632ada-…` | `Recycling request from {City}, {State}` | Make.com automation; agent pre-filters it away (`recycling_form_make_handled`, 314 rows) |
| Generic contact form (`src/pages/contact.astro`) | `ea4ac69c-…` | `Recycle Old Tech Contact Form` | Falls through to Gemini (22 rows) |

The city-page form asks the useful questions — `help_type` (drop off / schedule
pickup / business cleanout / data destruction / sell-buy), `devices`, `city`,
`state`, `zip_code`, `phone` — and feeds the Make.com flow that emails back
specific locations. The generic contact form collects only `name`, `email`,
`message`, so a recycling request arriving there has to be handled by hand.

Real examples from the queue:

> `name : Kevin` / `email : troskoskiki83@gmail.com` / `message : Hello i'm from
> Greencastle,PA — I'm trying to recycle an Old TV, it's a flat screen 65 Inch…`

> `name : Fred Buczynski` / `email : fcrman@aol.com` / `message : I have some
> old TV's that I hope to recycle. Is there any chance that your group would
> provide this recycling service or provide a group that has this service…`

Today these get a generic "visit our website and search your location" draft.
They should instead be pointed at the nearest city page's form (which runs the
existing automation end to end) or invited to reply with details.

### 2.2 🚨 Blocking prerequisite: replies to these people are going to Web3Forms

**This must be fixed before Part 2 is worth building, and it is the single most
serious defect found in this investigation.**

Verified from raw headers of a live contact-form message (UID 1428):

```
From:     "Notifications" <notify@web3forms.com>
Reply-To: fcrman@aol.com            <-- the actual human
To:       hello@recycleoldtech.com
```

- `lib/imap.ts` `parseFetched()` never reads `Reply-To`. `FetchedMessage` has no
  such field and `email_queue` has no such column.
- `api/discord.ts:232` and `:427` send with `to: row.fromAddr`.

So every approved reply to a form submission has been addressed to
**`notify@web3forms.com`**, not to the person who wrote in. Per the queue, that
is **~14 `sent` rows** across `support`, `claim`, `out_of_scope` and
`listing_request` — including a `listing_request`, i.e. the highest-value
category. Those people never got an answer, and the Discord card said "Sent".

This also silently affects `matchRecyclingRequest`'s sibling case and any other
sender that uses a `Reply-To` (mailing lists, ticketing systems, Google Groups).

**Fix:**

1. `db/schema.ts` — add `replyTo: text('reply_to')` to `email_queue`; generate
   and apply a migration.
2. `lib/imap.ts` — `FetchedMessage.replyTo?: string`, populated from
   `parsed.replyTo?.value?.[0]?.address`.
3. `lib/poll/runner.ts` — thread it through `InsertRowInput` / `insertRow`.
4. New `lib/mail/recipient.ts`:
   ```ts
   /** The address a reply must actually go to: Reply-To when present and not
    *  our own mailbox, else From. Never returns EMAIL_USER. */
   export function replyRecipient(row: {
     replyTo: string | null; fromAddr: string;
   }): { to: string; source: 'reply-to' | 'from' } | null
   ```
   Return `null` when the only candidate is `EMAIL_USER` or a
   `MAILER-DAEMON@…`/`noreply@…` address, and have Approve refuse to send with
   a clear card message instead of mailing ourselves.
5. `api/discord.ts` — both send paths use `replyRecipient(row)`.
6. `lib/discord/rest.ts` — the card's **From** field must show the resolved
   recipient, e.g.
   `Fred Buczynski <fcrman@aol.com> (via notify@web3forms.com)`. Right now the
   card shows `Notifications <notify@web3forms.com>`, which is exactly why this
   went unnoticed for three months.
7. **Backfill:** `scripts/backfill-reply-to.ts` — re-fetch the `Reply-To`
   header for existing rows by `imap_uid` and populate the new column. Then
   produce a report of the ~14 `sent` rows that went to Web3Forms so Adam can
   decide who to re-contact by hand. Recommend re-sending to those people; the
   drafts are already in `draft_reply`.
8. Add a unit test with a real Web3Forms header fixture asserting the recipient
   resolves to the submitter, plus one asserting a normal person's email still
   resolves to `From`.

### 2.3 New category: `recycling_help`

Add an eighth Gemini category, `recycling_help`, for *"a person (household or
business) asking where/how to recycle specific items"* — i.e. the request the
city-page form exists to answer. It is reply-worthy.

This splits out of today's `support`, which stays for everything else
(questions about an existing listing, site problems, how the directory works).
Rationale for a distinct category rather than prompt-tuning `support`:

- The reply is a **fixed template with one variable** (the city-page URL). It
  must not be free-written by the model — see 2.5.
- It lets us measure how much traffic is landing on the wrong form, which tells
  Adam whether the real fix is a site change (2.8).

Update in `lib/gemini/prompt.ts`, `lib/gemini/index.ts` (`GeminiCategory`,
`VALID_CATEGORIES`), and the `db/schema.ts` category comment.

### 2.4 Location extraction

Extend the Gemini JSON contract with a nullable location block:

```json
{
  "category": "recycling_help",
  "should_reply": true,
  "draft_reply": "",
  "reason": "...",
  "location": { "city": "Greencastle", "state": "PA", "zip": null },
  "items": ["TVs/Monitors"],
  "help_type": "Drop off at center"
}
```

Rules for the prompt:

- `location` is `null` unless the sender actually stated a place. **Never
  guess** from area code, email domain, or signature block.
- `state` may be a 2-letter code or a full name; the resolver normalizes.
- `items` / `help_type` use the exact vocabularies from
  `RecyclingRequestForm.astro` so the values stay comparable to real form
  submissions. Optional, nice-to-have for reporting.
- `parseClassifyResult()` must treat all three as optional and tolerate
  garbage (missing → `null`), preserving today's defensive-parse behaviour.

### 2.5 Resolving the city page URL — deterministic, never model-written

**Hard constraint: the LLM must never emit a `recycleoldtech.com` URL for this
flow.** A hallucinated `/states/pennsylvania/greencastle-township` 404s and the
lead is dead. The model outputs structured location fields; **code** looks up
the URL in a real index.

**City index.** `https://www.recycleoldtech.com/api/cities-data` returns
4,457 `{city, state, url}` records (370 KB, HTTP 200, verified). Ship a
committed snapshot rather than fetching at reply time:

- `scripts/sync-cities.ts` (`npm run sync:cities`) fetches the endpoint, writes
  `assets/city-index.json`, and **validates before overwriting**: ≥ 4,000
  records, 50 distinct states, every `url` matching `^/states/[a-z0-9-]+/[a-z0-9-]+$`.
  Abort on failure so a bad deploy of the site can't poison the agent.
- `lib/site/cityIndex.ts` loads it once at module scope into two maps:
  `"{cityslug}|{statelug}" → url` and `"{cityslug}" → url[]` (for the no-state
  case). Slugging must match the site's own `normalizeForUrl()`
  (`ewaste-dir/src/lib/supabase.ts`): lowercase, non-alphanumeric → `-`, trim
  leading/trailing `-`.
- Add a monthly cron or a `sync:cities` step to the release checklist; the site
  is statically generated so the city set changes rarely.

**Resolution ladder** (`lib/site/resolveCityPage.ts`):

| # | Input | Result |
| --- | --- | --- |
| 1 | city + state, exact slug match | `https://www.recycleoldtech.com{url}#recycling-request-form` → **template A** |
| 2 | city only, **unique** across all 50 states | same as 1 |
| 3 | city only, **ambiguous** (e.g. "Live Oak" exists in CA and TX — verified) | **template B**: ask which state, offer the reply path |
| 4 | city has no page, state known | state page `https://www.recycleoldtech.com/states/{state}` (verified: lists every city, e.g. 263 links for Pennsylvania) → **template C** |
| 5 | no location at all | **template D**: ask for city/state, offer the reply path |

Notes:
- **Do not build a geographic "nearest city" search.** Only 494 of 4,457 cities
  in the index carry coordinates, and the site's `/api/geocode` is *reverse*
  geocode (lat/lng → city) so there is no ZIP → coordinates path. A distance
  search over 11% of cities would confidently return a *worse* answer than the
  state page. Spot-checked coverage is good enough without it: Greencastle PA,
  Perkasie PA, Overland Park KS, Worcester MA, Live Oak TX all resolve.
- ZIP-only input: treat as no city (template D) in v1. If ZIP traffic turns out
  to be common, add a static ZIP → city/state table later; that is a separate
  piece of work, not a blocker.
- Every resolved URL should be **verified once at sync time**, not at reply
  time, by construction (the URL comes straight from the site's own index).

### 2.6 The reply templates

Deterministic, composed in `lib/mail/templates/recyclingHelp.ts`, not by
Gemini. House style from `lib/gemini/prompt.ts` applies: no em dashes, sign off
`RecycleOldTech / Adam` (the SMTP signature block in `lib/mail/signature.ts` is
appended on top automatically).

**Template A — city page resolved.** Both options, form first:

```
Hi {firstName},

Thanks for reaching out. We are a directory, so we do not haul or process
e-waste ourselves, but we can point you to the recyclers near you that do.

Two ways to get specifics:

1. Fill out the short form on our {City}, {State} page:
   {cityUrl}
   It asks a few quick questions (what you have, drop off vs pickup, your
   zip) and you will get an email back with specific locations that take
   your items.

2. Or just reply to this email with your zip code, what you are recycling,
   and whether you want to drop off or have it picked up. We will look it up
   and send you the options.

RecycleOldTech / Adam
```

**Template B — ambiguous city:** same shape, but option 1 becomes "let us know
which state you are in ({State1} or {State2}) and we will send the right page."

**Template C — no city page, state known:** option 1 links the state page and
says to pick the closest city, then use the form on that page.

**Template D — no location:** option 1 becomes "tell us your city and state (or
zip) and we will send you the page with the form for your area."

Open question for Adam: **should the recycling-form URL always be the *nearest*
city page, or is "the city they named" fine?** This spec assumes the latter
(the form collects the real zip anyway, and Make.com does the actual matching),
which is why 2.5 deliberately skips distance math. Flag if you want otherwise.

### 2.7 Where this plugs into the pipeline

`lib/poll/runner.ts` step 3-4, after `classifyAndDraft` returns:

```
if (classify.category === 'recycling_help') {
  const resolved = resolveCityPage(classify.location);   // deterministic
  draftReply = renderRecyclingHelp({ ...classify, resolved });  // overrides the model's draft
}
```

- Persist the resolution on the row for auditability — recommend
  `location_hint jsonb` and `resolved_city_url text` columns on `email_queue`
  (cheap, and makes 2.8's report a one-line query).
- The Discord card gains a **Routing** field: `Greencastle, PA → /states/pennsylvania/greencastle`
  or `no city page (state fallback)` or `location unknown`, so Adam can catch a
  bad resolution *before* approving. This is the human-in-the-loop check that
  makes it safe to auto-compose the body.
- Everything else (Approve / Edit / Reject) is unchanged.
- Also apply `recycling_help` to plain non-form emails (someone emailing
  `hello@` directly) — nothing about this is Web3Forms-specific.

### 2.8 Follow-up: fix it at the source

The agent is a patch; the real fix is that `/contact` does not offer a recycling
path at all. Recommend (in `ewaste-dir`, out of scope for this repo but worth
tracking):

- On `/contact`, add a prominent "Looking for a place to recycle something?
  Start here →" panel above the message box, linking `/states` or the search box.
- Add a "What is this about?" select to the contact form and pass it as a
  hidden Web3Forms field. That both improves the classification signal and
  deflects traffic.
- Use the `recycling_help` count from 2.7 to measure whether the deflection
  worked.

---

## Part 3 — Other problems found

Ranked by expected harm. Items 3.1 and 3.2 are already covered above (1.2 and
2.2) and are repeated here only to keep the ranking honest.

### 3.1 (= 1.2) `markSeen` deadlock — nothing is ever marked read. **Critical.**

### 3.2 (= 2.2) Replies go to `From` instead of `Reply-To`; ~14 replies were delivered to Web3Forms. **Critical.**

### 3.3 Reply threading is wrong — `In-Reply-To` points at the wrong message

`api/discord.ts:235` and `:430` pass `inReplyTo: row.inReplyTo`. `row.inReplyTo`
is the **inbound** message's own `In-Reply-To` header, i.e. its *parent*. For a
fresh inbound email that header is absent, so our reply carries **no**
`In-Reply-To` at all and clients thread it as a new conversation.

The reply's `In-Reply-To` must be the **inbound message's `Message-ID`**, i.e.
`row.messageId`, with `References` = `row.emailReferences` + `row.messageId`.

Also: `subject: row.subject ?? '(no subject)'` sends the subject verbatim, so
replies go out titled `Recycle Old Tech Contact Form` with no `Re:` prefix. Add
a `Re: ` prefix when the subject does not already start with a case-insensitive
`re:`.

**Fix:** in `lib/smtp.ts`, derive both from the row instead of trusting the
caller:
```ts
inReplyTo: `<${row.messageId}>`,                    // normalize angle brackets
references: [row.emailReferences, row.messageId].filter(Boolean).join(' '),
subject: /^re:/i.test(s) ? s : `Re: ${s}`,
```
Add unit tests for the angle-bracket normalization (`messageId` from mailparser
may or may not include them) and the `Re:` idempotency.

### 3.4 Approve is not idempotent — a double tap sends two emails

`handleApprove` (`api/discord.ts:196`) never checks `row.status`. The buttons
stay on the card until the `waitUntil` work finishes editing it, which is
several seconds later (SMTP + IMAP + DB + Discord PATCH). Two taps, or a
Discord interaction retry, sends the reply twice. Same for `handleEditSubmit`.

**Fix:** make the transition a conditional write and treat "no row updated" as
"already handled":
```ts
const claimed = await db.update(emailQueue)
  .set({ status: 'sending', updatedAt: new Date() })
  .where(and(eq(emailQueue.id, queueId), inArray(emailQueue.status, ['pending', 'error'])))
  .returning({ id: emailQueue.id });
if (claimed.length === 0) { /* log + edit card "already handled"; return */ }
```
Add `sending` to the documented status set in `db/schema.ts`. On failure, move
`sending` → `error` (which stays retryable, matching today's "keep the buttons"
behaviour). A stuck `sending` row is now also detectable, which it isn't today.

### 3.5 One poisonous message can stall the entire pipeline forever

`parseFetched()` (`lib/imap.ts`) throws when `raw.source` is missing. That throw
escapes the `for await` in `runBatch`, so no row is inserted for that UID, so
`highestPersistedUid` never reaches it, so **every subsequent poll re-fetches
the same message, throws again, and processes nothing** — permanent head-of-line
block with no alert. The same applies to any unexpected throw inside
`processMessage` outside its existing try/catch.

**Fix:** wrap the per-message body in `runBatch` in try/catch. On an
unhandleable message, insert a minimal `status='error'` row keyed on
`no-message-id:<uid>` (the synthesized-key path already exists in
`processMessage`), record the error, and let the cursor advance. A message we
cannot parse must never be able to block mail we can.

### 3.6 Bounces are invisible

25 `MAILER-DAEMON@…privateemail.com` "Undelivered Mail Returned to Sender"
messages are classified `other` → skipped, no card, no report. Their bodies
show the real failures are **typo'd addresses submitted through the
recycling form** (`dkrapp1959@gmail.com` → 550 no such user,
`mwamplemanj@hotmail.ccom` → bad domain — note the `.ccom`), with
`X-Postfix-Sender: hello@recycleoldtech.com`, i.e. the Make.com auto-reply
bounced.

That means real leads are silently going nowhere, and nobody knows.

**Recommendation:** a `bounce` pre-filter (deterministic — `From:` starts with
`MAILER-DAEMON@`, or `Content-Type: multipart/report; report-type=delivery-status`),
marked read + skipped, plus a weekly Discord digest: *"N bounces this week: {failed
address} → {reason}"*. Cheap, no LLM cost, and it surfaces both address typos
and any future deliverability problem with our own domain. Consider a
client-side `email` typo check on the form too (`.ccom`, `gmial`, etc.).

### 3.7 The 60-day age cutoff can silently drop mail

`api/poll.ts:36` caps fetches at `POLL_MAX_AGE_DAYS = 60`, applied as an IMAP
`since` on the search. Messages older than the cutoff are never yielded, so
never persisted — but the cursor still advances past them the moment any newer
message persists. If cron is broken or the mailbox is quiet for longer than 60
days, that mail is **skipped with no row, no log line, and no way to notice.**

**Fix:** when a run's search window starts above `lastUid + 1` — i.e. UIDs were
skipped by the date filter — log and count them (`skippedByAgeCutoff: n` in the
`RunSummary`) and include it in the Phase 9 error alert. Better: run the UID
search *without* `since`, then partition into "too old" and "in window", and
write a `status='skipped'`, `skip_reason='older_than_cutoff'` row for the former
so the audit trail is complete.

### 3.8 README documents backlog modes that return HTTP 400

`README.md` ("Background modes") documents `?mode=backlog-classify` and
`?mode=backlog-draft` as usable, including a `nextSince` paging workflow.
`api/poll.ts:100` rejects **any** `?mode=` with
`400 {"error":"backlog modes not yet implemented (Phase 8)"}`. Phase 8 is
unbuilt.

Given Part 1's fix plus the 1.5 reconcile script handle the actual backlog
problem, **recommend deleting the "Background modes" section from the README**
and marking Phase 8 in `ACTION_PLAN.md` as superseded, rather than building the
modes. If the drafting-on-demand half is still wanted, keep it as a separate
`?mode=draft-pending&category=…` and say so; do not leave docs describing a
400.

### 3.9 A retired Gemini model produces silent `status='error'` rows

Row from 2026-07-09:
```
classify error: {"error":{"code":404,"message":"This model models/gemini-2.5-flash
is no longer available. Please update your code to use a newer model…"}}
```
`.env` still pins `GEMINI_MODEL=gemini-2.5-flash`, and a live round trip today
succeeds — so this was transient or the id was un-retired. Either way:

- There is **no retry** around `classifyAndDraft` — one 5xx/404 and the message
  becomes an `error` row (recovered only because dedupe lets the cursor pass and
  nothing retries it — i.e. **it is never actually retried**; check
  `error` rows manually).
- There is **no alert** on `errors.length > 0` (Phase 9, unbuilt).

**Fix:** one retry with jittered backoff on 5xx/429 in `lib/gemini/index.ts`; a
`scripts/retry-errors.ts` to re-run classification for `status='error'` rows;
and ship the Phase 9 Discord error alert. A model retirement should page us, not
accumulate quietly.

### 3.10 The Edit modal will fail on long drafts

Discord `TEXT_INPUT` values are capped at **4000 characters**, and
`api/discord.ts:255` / `lib/discord/rest.ts:276` set `value: draftReply` with no
`max_length` and no truncation. A draft over 4000 chars makes Discord reject the
modal, and Adam sees only "This interaction failed."

**Fix:** set `max_length: 4000` and truncate `value` to 4000 with a logged
warning. Longer term, if drafts ever routinely exceed that, the Edit flow needs
a different surface (a follow-up message, or editing in Neon).

### 3.11 Smaller items

- **`appendSent()` is a stub** (`lib/imap.ts`) — outbound replies never appear
  in webmail's Sent folder, so from Adam's mail client the conversation looks
  one-sided and there is no record outside Neon. Worth finishing (Phase 9
  confirmed the folder is named `Sent`).
- **`sendReply` reports `appendedToSent: false` unconditionally** and the caller
  discards the result entirely (`void send`). Dead code; either use the send
  result (store the outbound `messageId` on the row — useful for tying a bounce
  back to a reply, see 3.6) or drop it.
- **Stale comments referencing `assertPeek`** in `lib/imap.ts`
  (`fetchByDateRange` doc block) — no such function exists.
- **`editCard(channelId, i.message?.id ?? '', …)`** — an empty message id
  produces a confusing 404 from Discord rather than a clear error. Guard and log.
- **`configCache` in `lib/mail/prefilter.ts`** is process-lifetime, which on
  Fluid Compute means a warm instance keeps stale pre-filter env after an env
  var change. Acceptable, but worth a comment so it isn't debugged twice.
- **Filter-drift detection was specced (Phase 8) and never built.** The
  recycling pre-filter requires an exact subject prefix `Recycling request from`
  *and* `notify@web3forms.com`. If the form's subject template ever changes, 300+
  form submissions per year start hitting Gemini and generating cards. Cheap
  guard: in each poll summary, warn when a `notify@web3forms.com` message did
  **not** match any pre-filter — that condition already fires for legitimate
  contact-form mail, so scope it to "subject looks like a recycling request but
  did not match."
- **`hello@recycleoldtech.com` appears as a sender on 7 rows** (SMTP test
  messages and self-CCs). `replyRecipient()` from 2.2 must refuse to send to our
  own mailbox — otherwise a self-addressed message plus an Approve tap is a mail
  loop.

---

## 3b. Deviations found during implementation review

Recorded here so the spec matches what shipped. Each was a defect in the
first implementation pass, caught by reviewing the working tree against
this document before commit.

- **§2.5 state codes.** The prompt permits `location.state` to be "a
  2-letter code or full name", but the resolver slugified it directly, and
  the index's state slugs come from full names — so `PA` became `pa` and
  matched nothing. `Live Oak, TX` was demoted to "ambiguous (California,
  Texas)" and `Springfield, IL` asked the sender to pick among eight
  states not including Illinois. Added `canonicalStateName()` /
  `stateNameFromSlug()` in `lib/site/cityIndex.ts` and normalize before
  slugifying.
- **§2.5 ladder ordering.** When the sender named a state but no
  city+state page existed, an ambiguous city name still won and produced
  template B. A stated state now prefers its state page (template C) over
  asking the sender to choose from a list that may exclude their own
  state.
- **§2.6 greeting.** The greeting used the From display name, which for
  the primary case (Web3Forms) is literally `Notifications` — every reply
  would have opened "Hi Notifications". Added `sender_name` to the model
  contract (the body carries the real name) plus `greetingName()`, which
  prefers it, reduces to a first name, and rejects bot display names.
- **§3.5 poison messages.** The guard was a try/catch around
  `processMessage` inside `runBatch`, but the cited failure —
  `parseFetched` throwing on a missing source buffer — happens inside the
  *fetch generator*, so it escaped the `for await` and the head-of-line
  block was not actually fixed. The generators now yield a degraded
  message carrying `parseError` and never throw per-message; the runner
  writes the error row. Both poison paths also now report `inserted` so
  the cursor genuinely advances (previously they reported `error`, which
  held the cursor — the opposite of the intent).
- **§3.7 age-cutoff metric.** The check counted UIDs at or *below* the
  cursor, i.e. already-processed mail — 982 messages in this mailbox, a
  permanently non-zero number that would have fired the new Discord alert
  on every 10-minute cron tick (~144 posts/day). Corrected to UIDs *above*
  the cursor excluded by the date filter, which is the actual silent-drop
  set and is 0 in steady state (both values verified live).
- **Threading + synthesized ids.** `row.messageId` is
  `no-message-id:<uid>` for messages that arrived without a Message-ID (an
  internal dedupe key). Passed as `inboundMessageId` it would have put a
  fabricated identifier on the wire, so `lib/mail/headers.ts` now treats
  that prefix as "no Message-ID".
- **Card readability.** Switching the card's `From` field to the resolved
  recipient dropped the sender's display name for ordinary senders.
  `recipientDisplay()` takes an optional `fromName` and restores
  `Jane Doe <jane@example.com>` — but only on the from branch, since on the
  reply-to branch the display name belongs to the bot.
- **Migrations were unapplied.** `drizzle/0001`–`0003` existed but Neon
  still had the pre-change schema, so deploying would have failed every
  insert. Applied before commit (additive nullable columns only, so
  backward-compatible with the previously-deployed code).

---

## 4. Suggested implementation order

Each step is independently shippable and testable. Steps 1-3 are the ones that
change outcomes for real people.

| # | Work | Why this order |
| --- | --- | --- |
| **1** | 2.2 `Reply-To` (schema + parse + `replyRecipient` + card shows real recipient + backfill/report) | Replies are going to the wrong address *right now*. Nothing else matters as much. |
| **2** | 1.3 lock fix + `markSeenBatch` + guard-rail `acquireTimeout` + mutex regression test | Stops the pile growing and reclaims ~30s per poll run. |
| **3** | 3.3 threading + `Re:` prefix, 3.4 Approve idempotency | Small, high-value correctness fixes to the send path, best done while it is already open. |
| **4** | 1.4 mark-read policy decisions + 1.5 `reconcile-seen.ts` one-time drain | Needs Adam's call on spam/other first. |
| **5** | Part 2: `recycling_help` category, location extraction, city index + `sync:cities`, resolver, templates, card Routing field | The feature ask. Depends on step 1. |
| **6** | 3.5 poison-message guard, 3.7 age-cutoff visibility, 3.9 Gemini retry + error alert | Hardening against silent failure. |
| **7** | 3.6 bounce pre-filter + weekly digest | New signal, no dependency. |
| **8** | 3.8 README/plan reconciliation, 3.10 modal cap, 3.11 cleanups | Paper cuts. |
| **9** | 2.8 site-side deflection on `/contact` (separate repo) | Reduces the volume the agent has to handle at all. |

---

## 5. Test plan

Unit / integration (`vitest`):

- Fake `ImapFlow` enforcing the real lock mutex: today's runner hangs, the fixed
  runner marks read. **This is the test that would have caught 3.1.**
- `replyRecipient()`: Web3Forms header fixture → submitter; plain sender → From;
  `EMAIL_USER` → `null`; `MAILER-DAEMON@…` → `null`.
- Threading: reply `In-Reply-To` equals the inbound `Message-ID`; `References`
  chain appends; `Re:` prefix is idempotent.
- Approve idempotency: two concurrent approves → exactly one `sendReply` call.
- `resolveCityPage()`: Greencastle+PA → exact; "Live Oak" alone → ambiguous;
  unknown city + known state → state page; `null` → unknown. Plus a slug test
  asserting parity with the site's `normalizeForUrl()` (`St.`, `O'`, `Mt.`
  cases — the site has special handling for these).
- `sync-cities` validation: a truncated/malformed payload aborts without
  overwriting the committed snapshot.
- `recycling_help` prompt cases through `scripts/test-gemini.ts`: the two real
  examples in 2.1, one with no location, one ambiguous, one genuine `support`
  question that must **not** become `recycling_help`.

Live verification before declaring done:

1. Trigger `/api/poll` manually; summary shows `errors: []` and a non-zero
   `markedRead` count.
2. Confirm in webmail that the newest DMARC/newsletter/recycling-form messages
   went read, and that pending-card messages did **not**.
3. Submit the real contact form with a recycling question naming a city; confirm
   the card shows the correct recipient and Routing line, approve it, and
   confirm the email lands in a real inbox, threaded, with the working city URL.
4. Click that URL and confirm it opens the city page scrolled to the form.
5. Double-tap Approve on a test card; confirm exactly one email.
6. Re-check the unread count: it should equal open cards + error rows.

---

## 6. Open questions for Adam

> **All six resolved by Adam on 2026-08-07 — all per recommendation.**

1. **Mark spam and `other` read?** (1.4) ✅ **Yes, both, env-gated, default true.**
   Target steady state: unread count == open cards + error rows.
2. **Nearest city, or the city they named?** (2.6) ✅ **The city they named.**
   The form re-collects the real zip and Make.com does the matching; distance
   math is not supportable with 11% coordinate coverage.
3. **The ~14 replies that went to Web3Forms** (2.2) ✅ **Re-send, after Adam
   eyeballs the list.** Backfill script produces the report; Adam reviews before
   re-sending the existing drafts.
4. **Kill Phase 8 backlog modes?** (3.8) ✅ **Yes — delete the README "Background
   modes" section, mark Phase 8 superseded in `ACTION_PLAN.md`.**
5. **Bounce digest** (3.6) ✅ **Weekly Discord digest** (~2/week volume).
6. **3 rows currently `pending`** ✅ **Leave them until step 1 ships**, then
   re-run `npm run refresh:cards` so the cards show the correct recipient.
