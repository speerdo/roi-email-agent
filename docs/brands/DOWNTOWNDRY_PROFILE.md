# DowntownDry brand profile (content pack)

Status: **draft for review** — Task 2 deliverable, 2026-10-12. Author: Pollen (Deepseek).
Related: [`../EMAIL_IMPLEMENTATION_PLAN.md`](../EMAIL_IMPLEMENTATION_PLAN.md),
[`../SPEC_TRIAGE_FIXES.md`](../SPEC_TRIAGE_FIXES.md), `~/.buzz/PLANS/ROI_EMAIL_AGENT_DOWNTOWNDRY.md`.

This document is the content half of adding **DowntownDry** as a second brand to
the roi-email-agent pipeline. It holds the Gemini system prompt, the category
table, the deterministic pre-filters, and synthetic Web3Forms fixtures for
tests. The code half (brand profile type, registry, per-brand wiring) lives in
another PR.

Everything here is derived from the DowntownDry source of truth in
`~/Projects/DowntownDry`:

- `src/pages/contact.astro` — the contact form (topics, fields, FAQ facts, 48h
  reply promise, `hello@downtowndry.bar`).
- `src/pages/about.astro` — mission, room types, verification posture.
- `src/pages/{index,blog,about,shop}.astro` — the four newsletter signup forms
  and their exact subjects.
- `public/brand/dd-logo-sign.svg`, `dd-logo-coaster.svg` — the logo source.

Brand facts used below, with sources:

| Fact | Source |
| --- | --- |
| Directory of alcohol-free / sober-friendly / kava / legal delta-THC venues across the US | `about.astro` (`roomTypes`) |
| Basic listings are **free** | `contact.astro` FAQ Q2 |
| Every submission is **reviewed and verified** (venue directly, its site/menu, in person where possible) before it goes live | `contact.astro` FAQ Q4 |
| Replies go out **within 48 hours** | `contact.astro` ("We reply within 48 hours.") |
| Enhanced listings **do not exist yet** — do not quote pricing or promise features | adam, 2026-10-12 (plan Decisions) |
| Shops through a partnership with Better Rhodes | `about.astro` (`theDifference`) |
| Contact topics: Venue Submission, Listing Update, Website Feedback, Press Inquiry, Partnership Opportunity, Other | `contact.astro` (`topics`) |

---

## 1. Gemini system prompt

Same JSON output contract as RecycleOldTech (`lib/gemini/prompt.ts`): one
object, no markdown fences, `category` / `should_reply` / `draft_reply` /
`reason` / `sender_name`, plus the optional `location` / `items` / `help_type`
fields (kept for contract parity; DowntownDry does not use a city-page resolver,
so they can stay null).

House style, carried over from ROI and enforced by the shared code:

- **No em dashes** (`--` or `—`) anywhere in `draft_reply`.
- **No sign-off.** The branded signature is appended at send time by
  `lib/mail/signature.ts`; `stripDraftSignoff()` is the backstop. A model-written
  sign-off renders twice.
- **Do not invent services, pricing, or features.** Enhanced listings do not
  exist yet, so those drafts say Adam will follow up, nothing more.
- `draft_reply` is written **as DowntownDry, in Adam's voice** (friendly,
  professional, concise).

The prompt is a single constant so a tweak is a one-line diff. It reads
`BrandProfile.systemPrompt` in the multi-brand refactor; the ROI system prompt
stays as-is.

```text
You are the email assistant for DowntownDry.bar. You triage inbound email and
draft replies AS Downtown Dry, in Adam's voice (friendly, professional, concise,
no em dashes).

=== ABOUT DOWNTOWNDRY (use this to draft accurately) ===
What we ARE: a directory of rooms across the US that pour something worth
ordering without the proof. Specifically, we list and review:
- Fully alcohol-free venues (nothing alcoholic served).
- Sober-friendly bars, restaurants and cafes with a real zero-proof menu.
- Traditional kava bars.
- Legal delta-THC venues (hemp-derived, lab-tested, dose on the menu).

What we do NOT do (do NOT imply we offer these; politely decline):
- We do NOT sell alcohol or drinks ourselves (the shop is a separate retail
  partnership, not something we fulfill).
- We do NOT run or own the venues we list.
- We do NOT provide medical, recovery, or legal advice.
- We do NOT yet offer enhanced or paid listings as a product. If someone asks,
  do not quote a price or promise features; say Adam will follow up.

Facts you may state:
- Basic listings are free, and always will be.
- Every submission is reviewed, then checked against the venue directly, its
  website and its current menu, and in person where we can get there. Nothing
  goes on the list unchecked.
- We reply within 48 hours.

=== HOW TO ROUTE EACH INQUIRY (what the draft should DRIVE TOWARD) ===
- Someone suggests a venue (themself, or somewhere they found) -> category
  "venue_submission". Thank them, say it will be verified, and ask for any
  missing detail that would speed verification: the venue name, the city and
  state, what kind of place it is, and what it actually pours.
- An owner or guest corrects an existing listing (hours, address, closed,
  changed menu) -> category "listing_update". Thank them, say it will be
  checked and updated, no need to do anything else.
- A venue asks about promotion, a featured spot, or a paid/enhanced listing ->
  category "enhanced_listing". Reply that we are interested and that Adam will
  follow up with details. Do NOT invent pricing or features.
- A brand, affiliate, or business proposes a partnership -> category
  "partnership". A warm, honest reply that we are open to people building the
  same thing and Adam will follow up.
- A journalist or researcher asks for an interview, data, or comment ->
  category "press". Happy to talk, and Adam will follow up.
- Site feedback, a correction to the website (not a venue), a bug, or a strong
  opinion about a mocktail -> category "feedback". Short, warm thanks.
- Anything asking for something we do not offer (medical/recovery advice,
  buying drinks, legal advice) -> category "out_of_scope". Short, polite,
  honest decline. Do not invent a service.
- Cold sales pitches aimed AT us (SEO, link building, web design, "boost your
  traffic"), mass outreach, irrelevant solicitations -> "spam", should_reply
  false.
- Newsletters, notifications, and anything ambiguous with no reply needed ->
  "other", should_reply false.

IMPORTANT: an unsolicited cold email is NOT automatically spam. A real venue
owner or a reader suggesting a place, even cold, is a venue_submission and IS
reply-worthy. Judge by intent and relevance to an alcohol-free venue directory,
not by whether it was solicited.

Do NOT sign off. End draft_reply with the last sentence of the body: no
"Thanks,", no "Best regards,", no name and no brand line. Code appends the real
signature (Adam, the domain, the logo) after your text, so a sign-off from you
would show up twice.

Return ONLY JSON, no markdown fences:
{
  "category": "venue_submission|listing_update|enhanced_listing|partnership|press|feedback|out_of_scope|spam|other",
  "should_reply": true|false,
  "draft_reply": "string or empty",
  "reason": "one short phrase on why",
  "sender_name": "string or null"
}

"sender_name" is the name of the HUMAN who wrote the email, as stated in the
body. Form submissions arrive from a notification bot, so the From header's
display name is often useless ("Notifications") while the body carries the real
name (e.g. a "name :" line). Extract the human's name there. Set it to null when
the body does not state a name; never copy a bot or notification display name.

For DowntownDry there is no city-page lookup. Do NOT emit any URL the sender did
not provide, and do not add location/items/help_type fields.
```

Notes for the implementer:

- The ROI prompt and the DD prompt share the same output contract by design so
  `parseClassifyResult()` (and the future split classify/draft path) needs no
  brand-aware changes.
- DD has no `recycling_help` equivalent: there is no deterministic template path,
  so every reply-worthy DD category gets a model-drafted `draft_reply`.

---

## 2. Categories

Nine LLM categories. A message is reply-worthy when the work needs a human
answer; everything else is suppressed.

| category | trigger | reply-worthy | what the draft should say |
| --- | --- | --- | --- |
| `venue_submission` | someone suggests a venue, theirs or found | yes | Thank them. Say it will be verified (venue directly, its menu, in person where we can). Ask for anything missing that speeds it up: name, city and state, what kind of place it is, what it pours. Note basic listings are free. |
| `listing_update` | owner or guest corrects an existing listing (hours, address, closed, menu) | yes | Thank them. Say we will check and update it. No further action needed from them. |
| `enhanced_listing` | venue asks about promotion, a featured spot, or a paid listing | yes | We are interested, and Adam will follow up with details. Do NOT state a price or promise features, because enhanced listings do not exist yet. |
| `partnership` | brand, affiliate, or business proposes working together | yes | Warm and honest: we are open to people building the same thing, and Adam will follow up. Ask for a sentence on what they have in mind if it is missing. |
| `press` | journalist, researcher, interview or data request | yes | Happy to talk. Adam will follow up. Do not release data or make claims about numbers we cannot cite. |
| `feedback` | website feedback, site correction, bug, or an opinion | yes | Short, warm thanks. If it is a concrete site bug, say we will look. |
| `out_of_scope` | asks for something we do not offer (medical/recovery/legal advice, selling drinks) | yes | Short, polite, honest decline. Point to what we actually are: a directory. Do not invent a service. |
| `spam` | cold sales pitch at us, mass outreach, irrelevant solicitation | no | empty |
| `other` | newsletters/notifications that slipped the pre-filters, ambiguous, nothing to answer | no | empty |

`newsletter_signup` is deliberately **not** an LLM category. Newsletter
submissions are removed by the deterministic pre-filter (section 3) before any
model call, stored in the newsletter table, and announced with a one-line Discord
message when Task 3 lands. The same applies to `dmarc` and `bounce`.

`should_reply` is a separate boolean from `category` so the model can mark a
reply-worthy category with an empty draft if it is ever unsure; the runner
already treats `should_reply=true, draft_reply=""` as a card with an empty body.

---

## 3. Pre-filters

Pre-filters run in code **before** any Gemini call, in this order (first match
wins). They are configured per brand. The critical difference from ROI: DD's
**contact-form mail must reach Gemini**, so nothing may filter on
`notify@web3forms.com` alone.

### 3.1 Newsletter signups — skip, store, notify (do not filter on sender alone)

Four DD pages post a newsletter signup through Web3Forms with
`from_name="Downtown Dry Newsletter"` and a subject of
`New Newsletter Subscriber - <Page>`:

| Page | Subject (`New Newsletter Subscriber - …`) |
| --- | --- |
| Homepage | `Homepage` |
| Blog | `Blog Page` |
| About | `About Page` |
| Shop | `Shop Page` |

Filter config for DD:

- `NEWSLETTER_FROM=` (empty — must be empty; matching the Web3Forms sender
  would swallow every contact-form message too).
- `NEWSLETTER_SUBJECTS=New Newsletter Subscriber`
- `NEWSLETTER_MARK_READ=true`

Match (existing `matchNewsletter` logic): sender contains `NEWSLETTER_FROM`
OR subject contains any `NEWSLETTER_SUBJECTS` entry. With `NEWSLETTER_FROM`
empty and the subject set, only the four signups match. Task 3 stores the
signup (email + source) in a `newsletter_subscribers` table and posts one line
to DD's Discord channel; the pre-filter itself only marks read and skips.

> Caution: if a future DD form also uses the `New Newsletter Subscriber`
> prefix for something that needs a reply, this filter would hide it. Keep the
> prefix unique to signups.

### 3.2 Web3Forms contact form — must NOT be filtered

The contact form (`contact.astro`) posts through Web3Forms with
`from_name="Downtown Dry Contact Form"` and a subject set by the chosen topic:
`Venue Submission`, `Listing Update`, `Website Feedback`, `Press Inquiry`,
`Partnership Opportunity`, or `Other`. These are the mail we reply to.

- DD must **not** carry ROI's `AUTOMATED_FORM_SUBJECTS=Recycling request from`
  filter. If it did (with the shared `notify@web3forms.com` sender), it would
  silently skip DD mail whose subject happened to start with that prefix, which
  cannot happen today but is a pointless landmine.
- In the multi-brand profile, DD's prefilter list is just
  `[newsletter, dmarc, bounce]`. No form pre-filter.
- Replies must go to **Reply-To** (the submitter), never to
  `notify@web3forms.com`. `lib/mail/recipient.ts` already resolves this; DD
  inherits it unchanged.

### 3.3 DMARC and bounce — same as ROI

- `DMARC_SUBJECTS=Report domain:,Report Domain:` (aggregate reports), marked
  read.
- Bounce detection (`matchBounce`) is built in: `MAILER-DAEMON@` / `postmaster@`
  sender, or `multipart/report` with `report-type=delivery-status`. Always
  marked read.

### 3.4 Resulting DD pre-filter summary

| # | filter | match | outcome |
| --- | --- | --- | --- |
| 1 | newsletter | subject contains `New Newsletter Subscriber` | skip, mark read, store + notify (Task 3) |
| 2 | dmarc | subject contains `Report domain:` | skip, mark read |
| 3 | bounce | MAILER-DAEMON/postmaster sender or delivery-status report | skip, mark read |
| — | contact form | (none) | **falls through to Gemini** |
| — | everything else | (none) | falls through to Gemini |

---

## 4. Synthetic fixtures (Web3Forms format)

These mirror the shape of real Web3Forms notifications. The authoritative real
example is quoted in `docs/SPEC_TRIAGE_FIXES.md` §2.1 (`name : Kevin` /
`email : …` / `message : …`, `From: "Notifications" <notify@web3forms.com>`,
`Reply-To: <submitter>`). One fixture per contact-form topic, so all six form
subjects are covered. `sender_name` is extracted from the body `name :` line,
not from the From header.

Test shape (as a plain-text fixture):

```
From: "Notifications" <notify@web3forms.com>
Reply-To: <submitter address>
To: hello@downtowndry.bar
Subject: <contact-form topic>

name : <submitter name>
email : <submitter address>
message : <message body>
```

### F1 — Venue submission

```
From: "Notifications" <notify@web3forms.com>
Reply-To: jane.guest@example.com
To: hello@downtowndry.bar
Subject: Venue Submission

name : Jane Guest
email : jane.guest@example.com
message : There is a place on Geer Street in Durham called The Zero Room. Fully
alcohol free, a six-deep zero-proof list, open late. You should list it.
```

- expected category: `venue_submission`
- expected `should_reply`: `true`
- expected `sender_name`: `Jane Guest`
- draft: thanks, will verify, asks only for what is missing (address, what it
  pours). No URL.

### F2 — Listing update

```
From: "Notifications" <notify@web3forms.com>
Reply-To: marcus@kavaloungepdx.example
To: hello@downtowndry.bar
Subject: Listing Update

name : Marcus Webb
email : marcus@kavaloungepdx.example
message : Kava Lounge on SE Division in Portland moved two doors down and is
open until 2am now. The address on your page is old.
```

- expected category: `listing_update`
- expected `should_reply`: `true`
- expected `sender_name`: `Marcus Webb`
- draft: thanks, will check and update.

### F3 — Website feedback

```
From: "Notifications" <notify@web3forms.com>
Reply-To: sam.reed@example.net
To: hello@downtowndry.bar
Subject: Website Feedback

name : Sam Reed
email : sam.reed@example.net
message : The city filter on the map resets every time I open a venue and come
back. On Android, Chrome.
```

- expected category: `feedback`
- expected `should_reply`: `true`
- expected `sender_name`: `Sam Reed`
- draft: short warm thanks, we will look at it. No venue verification language.

### F4 — Press inquiry

```
From: "Notifications" <notify@web3forms.com>
Reply-To: reporter@dailybrew.example
To: hello@downtowndry.bar
Subject: Press Inquiry

name : Dana Cole
email : reporter@dailybrew.example
message : I am writing a piece on how the alcohol-free bar scene is growing for
a food and drink section. Would Adam be up for a short interview and could you
share how many venues and cities you cover now?
```

- expected category: `press`
- expected `should_reply`: `true`
- expected `sender_name`: `Dana Cole`
- draft: happy to talk, Adam will follow up. Do not quote unverified numbers.

### F5 — Partnership opportunity

```
From: "Notifications" <notify@web3forms.com>
Reply-To: hello@betterrhodes.example
To: hello@downtowndry.bar
Subject: Partnership Opportunity

name : Priya Nair
email : hello@betterrhodes.example
message : We supply craft NA beer and zero-proof spirits and we would like to
talk about a partnership with your directory and shop.
```

- expected category: `partnership`
- expected `should_reply`: `true`
- expected `sender_name`: `Priya Nair`
- draft: warm, open to people building the same thing, Adam will follow up.

### F6 — Other (promotion / enhanced listing)

The contact form's `Other` topic. This is where a venue asking about promotion
lands, since there is no dedicated "enhanced listing" topic yet.

```
From: "Notifications" <notify@web3forms.com>
Reply-To: owner@thequietroom.example
To: hello@downtowndry.bar
Subject: Other

name : Elena Fischer
email : owner@thequietroom.example
message : We run a fully alcohol-free space in Austin and love what you are
doing. Can we get a featured spot or promotion on the site? What would that
involve and what does it cost?
```

- expected category: `enhanced_listing`
- expected `should_reply`: `true`
- expected `sender_name`: `Elena Fischer`
- draft: interested, Adam will follow up with details. **No price, no promised
  features** (enhanced listings do not exist yet).

### Additional negative fixtures (recommended, beyond the six)

| id | From / Subject / body cue | expected category | should_reply |
| --- | --- | --- | --- |
| N1 | `notify@web3forms.com`, `New Newsletter Subscriber - Blog Page`, body `email : reader@example.com` | *(removed by pre-filter)* `newsletter_signup` | n/a (no LLM) |
| N2 | `seo@rankup.example`, subject `Boost your traffic with guest posts`, generic SEO pitch | `spam` | `false` |
| N3 | `someone@example.com`, subject `Can you tell me if kava is safe with my medication?` | `out_of_scope` | `true` (short decline; not medical advice) |
| N4 | `notify@web3forms.com`, subject `Recycling request from Austin, TX` sent to a DD mailbox | `other` (falls through, irrelevant to DD) | `false` |

---

## 5. Signature

Per adam's decision (2026-10-12), the signature is the same **shape** for both
brands: `Adam` on the first line, the domain link on the next, then the logo.

Text:

```
Adam
downtowndry.bar
```

HTML: `Adam`, then a link to `https://downtowndry.bar`, then the inline
(`cid:`) logo.

- Logo asset: `assets/images/downtowndry-signature-logo.png`, rendered from
  `DowntownDry/public/brand/dd-logo-sign.svg` at 300px wide, transparent
  background (the wordmark reads better than the coaster monogram at signature
  size). Generated for this pack; the brand profile points at this path.
- `DRAFT_SIGNOFF` / the sign-off stripper must recognise the DD family too
  ("Adam", "Adam / Downtown Dry", "Downtown Dry / Adam", the bare brand line),
  so old or model-written sign-offs are still removed. The shared
  `stripDraftSignoff()` regexes need DD variants added in the signature PR.

---

## 6. Handoff / open items

- The exact Web3Forms body format is taken from the real ROI contact-form
  example in `SPEC_TRIAGE_FIXES.md` §2.1. Before go-live, confirm one live DD
  contact submission lands in `hello@downtowndry.bar` (adam switches the
  Web3Forms notification address; plan Decisions) and matches this shape. If
  Web3Forms formats fields differently (for example as `Name:` with a capital),
  update the fixtures here.
- Enhanced-listings copy stays at "Adam will follow up" until the product
  exists.
- Task 3 wires the profile into code: `brand` column, `/api/poll?brand=downtowndry`,
  Discord routing to `#downtowndry-approvals` (`1559205420650733638`), `DD_*` env
  vars, and the `newsletter_subscribers` table plus one-line notification.
