// lib/mail/templates/recyclingHelp.ts
//
// Deterministic reply templates for the recycling_help category. Composed
// here, never by the LLM — the model emits structured location fields and
// code looks up the city-page URL from the site's own index. A
// hallucinated /states/pennsylvania/greencastle-township URL 404s and the
// lead is dead, so the LLM is barred from emitting any recycleoldtech.com
// URL for this flow. See docs/SPEC_TRIAGE_FIXES.md §2.5-2.6.
//
// House style from lib/gemini/prompt.ts applies: no em dashes, and NO
// sign-off. The branded signature block (lib/mail/signature.ts) is
// appended at send time and already carries the name, brand and site, so
// a sign-off here would render twice. The template ends on the last line
// of the body; stripDraftSignoff() is the backstop, not the mechanism.

import type { ResolvedCityPage } from '../../site/resolveCityPage.js';
import { canonicalStateName } from '../../site/cityIndex.js';
import type { ClassifyLocation } from '../../gemini/index.js';

/** From display names that belong to notification bots, not people. A
 *  Web3Forms submission arrives as `From: "Notifications"
 *  <notify@web3forms.com>`, so greeting off the header would open with
 *  "Hi Notifications" on exactly the traffic this template exists for.
 *  Matched case-insensitively against the whole display name. */
const BOT_DISPLAY_NAMES = new Set([
  'notifications',
  'notification',
  'noreply',
  'no-reply',
  'mailer-daemon',
  'postmaster',
  'web3forms',
  'contact form',
  'website',
  'admin',
]);

/**
 * Pick the greeting name for a reply, preferring the name the sender stated
 * in the body (extracted by the model as `sender_name`) over the From
 * display name, and reducing either to a first name so the greeting reads
 * "Hi Fred", not "Hi Fred Buczynski".
 *
 * Returns null when neither source yields a usable human name, in which
 * case the template opens with a bare "Hi".
 */
export function greetingName(
  senderName: string | null | undefined,
  fromName: string | null | undefined,
): string | null {
  for (const candidate of [senderName, fromName]) {
    const name = (candidate ?? '').trim();
    if (!name) continue;
    if (BOT_DISPLAY_NAMES.has(name.toLowerCase())) continue;
    // An address-shaped display name ("jane@example.com") is not a name.
    if (name.includes('@')) continue;
    const first = name.split(/\s+/)[0]?.replace(/[^\p{L}\p{N}'-]/gu, '') ?? '';
    if (first.length > 0) return first;
  }
  return null;
}

export interface RecyclingHelpInput {
  /** Greeting name for the reply. Use greetingName() to derive it — the
   *  From display name alone is wrong for form submissions. Null falls
   *  back to a bare "Hi". */
  firstName: string | null;
  /** The resolved city page (template kind + URL + label). */
  resolved: ResolvedCityPage;
  /** Original location, echoed into template B/D where we ask for the
   *  missing piece. */
  location: ClassifyLocation | null;
}

/**
 * Compose the recycling_help reply body for the given resolution. The
 * template kind comes from resolveCityPage(); each branch produces a
 * slightly different option 1, but all four share the same opening and
 * the same "or just reply with details" fallback path.
 */
export function renderRecyclingHelp(input: RecyclingHelpInput): string {
  const greeting = input.firstName ? `Hi ${input.firstName}` : 'Hi';
  const { template, url, ambiguousStates, location } = input.resolved;

  const opening = `${greeting},

Thanks for reaching out. We are a directory, so we do not haul or process
e-waste ourselves, but we can point you to the recyclers near you that do.

Two ways to get specifics:`;

  // Name the place in template A so the reader can verify we understood
  // where they are before clicking (and tell us if we got it wrong).
  const cityLabel = (() => {
    const city = location?.city?.trim();
    if (!city) return 'our city page';
    const state = location?.state ? canonicalStateName(location.state) : '';
    return state ? `our ${city}, ${state} page` : `our ${city} page`;
  })();

  switch (template) {
    case 'A':
      return `${opening}

1. Fill out the short form on ${cityLabel}:
   ${url}
   It asks a few quick questions (what you have, drop off vs pickup, your
   zip) and you will get an email back with specific locations that take
   your items.

2. Or just reply to this email with your zip code, what you are recycling,
   and whether you want to drop off or have it picked up. We will look it
   up and send you the options.`;

    case 'B': {
      const states = ambiguousStates.length > 0
        ? ambiguousStates.join(' or ')
        : 'the state you are in';
      // Keep interpolated values (city name, state list) on their own
      // lines: both vary in length, and inlining them mid-sentence makes
      // the wrapped plain-text body come out ragged.
      return `${opening}

1. We have a page for more than one ${location?.city ?? 'city'}.
   Let us know which state you are in (${states}) and we will send you
   the right page with the short recycling form.

2. Or just reply to this email with your state, zip code, what you are
   recycling, and whether you want to drop off or have it picked up. We
   will look it up and send you the options.`;
    }

    case 'C':
      return `${opening}

1. We do not have a dedicated page for your city yet, but we do have a
   page for your state with a list of every city we cover:
   ${url}
   Pick the closest city on that page, then use the short recycling form
   there to get specific locations that take your items.

2. Or just reply to this email with your zip code, what you are recycling,
   and whether you want to drop off or have it picked up. We will look it
   up and send you the options.`;

    case 'D':
      return `${opening}

1. Tell us your city and state (or zip) and we will send you the page
   with the short recycling form for your area.

2. Or reply to this email with what you are recycling and whether you
   want to drop off or have it picked up, and we will look it up and send
   you the options.`;
  }
}