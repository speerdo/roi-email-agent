// lib/brands/downtowndry.ts
//
// The DowntownDry brand profile. Content lifted verbatim from
// docs/brands/DOWNTOWNDRY_PROFILE.md (Task 2). This file is the single
// home for DD's prompt, categories, prefilter marks and signature; it
// carries no runtime wiring of its own until Task 3 threads the brand
// registry through poll/discord/smtp.

import type { BrandProfile } from './types.js';

export const DOWNTOWNDRY_BRAND: BrandProfile = {
  id: 'downtowndry',
  domain: 'downtowndry.bar',
  fromName: 'Downtown Dry',
  // DD_EMAIL_USER / DD_EMAIL_PASS / DD_DISCORD_CHANNEL_ID. Missing vars =>
  // getBrandEnv returns null and the poll skips DD cleanly (200, not 500).
  envPrefix: 'DD',

  systemPrompt: `You are the email assistant for DowntownDry.bar. You triage inbound email and
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
not provide, and do not add location/items/help_type fields.`,

  categories: [
    'venue_submission',
    'listing_update',
    'enhanced_listing',
    'partnership',
    'press',
    'feedback',
    'out_of_scope',
    'spam',
    'other',
  ],

  // DD's pre-filter config, used verbatim by runPrefilters (non-ROI brands
  // do NOT read the AUTOMATED_FORM_* / NEWSLETTER_* env vars). The
  // content-pack rules:
  //   - NO automated-form skip: the contact form must reach Gemini. An
  //     empty subjects list / empty from means the filter never matches.
  //   - Newsletter matches on SUBJECT only ("New Newsletter Subscriber");
  //     never on the Web3Forms sender alone, or it would swallow every
  //     contact-form message (they share the sender). NEWSLETTER_FROM is
  //     deliberately empty.
  //   - DMARC and bounce are identical to ROI (shared infrastructure mail).
  prefilter: {
    automatedFormSubjects: [],
    automatedFormFrom: '',
    automatedFormMarkRead: true,
    newsletterFrom: '',
    newsletterSubjects: ['New Newsletter Subscriber'],
    newsletterMarkRead: true,
    dmarcSubjects: ['Report domain:', 'Report Domain:'],
    dmarcFrom: '',
    dmarcMarkRead: true,
  },

  cardPrefix: '[DD]',

  // Newsletter signups are captured (newsletter_subscribers upsert + a
  // one-line Discord announcement). See lib/poll/runner.ts.
  newsletterSubscribers: true,

  signature: {
    name: 'Adam',
    siteLabel: 'downtowndry.bar',
    siteUrl: 'https://downtowndry.bar',
    logoPath: 'assets/images/downtowndry-signature-logo.png',
    logoWidth: 140,
    // 140 * 263 / 300, rounded — the asset is 300x263, so the intrinsic
    // ratio is preserved and clients that ignore CSS don't squash it.
    logoHeight: 123,
    logoCid: 'dd-signature-logo',
    logoFilename: 'downtowndry-logo.png',
  },

  // Same idea as ROI: these live here so old/model-written DD sign-offs get
  // cleaned from drafts before the branded signature is appended. The brand
  // token accepts "DowntownDry" and "Downtown Dry", with or without ".bar".
  signoffPatterns: [
    // The house sign-off, either order, any slash/dash spacing.
    /^downtown ?dry(?:\.bar)?\s*[/|-]\s*adam(?: speer)?$/,
    /^adam(?: speer)?\s*[/|-]\s*downtown ?dry(?:\.bar)?$/,
    // Either half alone, for the "Adam" over "Downtown Dry" variant the
    // model produces when it ignores the exact wording.
    /^(?:the )?downtown ?dry(?:\.bar)?(?: team)?$/,
    /^adam(?: speer)?$/,
    // A bare valediction with nothing after it. Must match the WHOLE line:
    // "Thanks again for reaching out!" is body text and stays.
    /^(?:thanks|thanks again|thank you|thank you again|many thanks|thanks so much|best|best regards|kind regards|warm regards|warmly|regards|cheers|sincerely|all the best|talk soon)$/,
  ],
};
