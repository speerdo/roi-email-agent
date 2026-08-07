// lib/site/resolveCityPage.ts
//
// Resolve a recycling_help sender's location to a real recycleoldtech.com
// city page URL, deterministically, never via the LLM.
//
// Resolution ladder (SPEC §2.5):
//   1. city + state, exact slug match   -> template A (city page)
//   2. city only, unique across all 50   -> template A
//   3. city only, ambiguous              -> template B (ask which state)
//   4. city has no page, state known     -> template C (state page)
//   5. no location at all                -> template D (ask for city/state)
//
// The LLM must never emit a recycleoldtech.com URL for this flow — a
// hallucinated /states/pennsylvania/greencastle-township 404s and the lead
// is dead. The model outputs structured location fields; this module
// looks up the URL in the committed site index (assets/city-index.json).
//
// No distance math: only 494 of 4,457 cities carry coordinates, and the
// site's /api/geocode is reverse-only. A distance search over 11% of
// cities would confidently return a worse answer than the state page.
// Per Adam's decision 2026-08-07: link the city the sender named, not the
// nearest city with a page — the form re-collects the real zip anyway and
// Make.com does the actual matching.

import {
  loadCityIndex,
  slugify,
  canonicalStateName,
  stateNameFromSlug,
  type CityIndex,
} from './cityIndex.js';
import type { ClassifyLocation } from '../gemini/index.js';

export type TemplateKind = 'A' | 'B' | 'C' | 'D';

export interface ResolvedCityPage {
  template: TemplateKind;
  /** Absolute URL to the city or state page with the form anchor, when
   *  one was resolved. Null for template D (no location). For template A
   *  this is the city page + #recycling-request-form. For template C this
   *  is the state page (the anchor is invalid on a state page, so we
   *  leave it off). */
  url: string | null;
  /** Display form for the Discord card's Routing field, e.g.
   *    "Greencastle, PA -> /states/pennsylvania/greencastle"
   *    "Live Oak (ambiguous: CA, TX) -> ask which state"
   *    "no city page (state fallback: PA) -> /states/pennsylvania"
   *    "location unknown -> ask for city/state"
   *  Lets Adam catch a bad resolution BEFORE approving. */
  routingLabel: string;
  /** The ambiguous state names when template === 'B', for the template
   *  body to enumerate. Empty for other templates. */
  ambiguousStates: string[];
  /** Original input location, echoed back for the template body. */
  location: ClassifyLocation | null;
}

const SITE_ORIGIN = 'https://www.recycleoldtech.com';
const FORM_ANCHOR = '#recycling-request-form';

/**
 * Resolve a location to a city-page URL + template kind. Pure function
 * over the committed index — no network, no LLM.
 */
export function resolveCityPage(
  location: ClassifyLocation | null | undefined,
  index: CityIndex = loadCityIndex(),
): ResolvedCityPage {
  if (!location || (!location.city && !location.state && !location.zip)) {
    return {
      template: 'D',
      url: null,
      routingLabel: 'location unknown -> ask for city/state',
      ambiguousStates: [],
      location: location ?? null,
    };
  }

  // The model may emit state as a 2-letter code or a full name (the prompt
  // explicitly allows both). The index's state slugs come from FULL names,
  // so "PA" must be expanded to "Pennsylvania" BEFORE slugifying — slugify
  // alone yields "pa", which matches nothing and silently demotes an
  // exactly-resolvable location to "ambiguous" or "unknown".
  const cityRaw = location.city?.trim() ?? '';
  const stateRaw = location.state ? canonicalStateName(location.state) : '';
  const citySlug = cityRaw ? slugify(cityRaw) : '';
  const stateSlug = stateRaw ? slugify(stateRaw) : '';

  // 1. city + state exact match.
  if (citySlug && stateSlug) {
    const exact = index.byCityState.get(`${citySlug}|${stateSlug}`);
    if (exact) {
      const url = `${SITE_ORIGIN}${exact}${FORM_ANCHOR}`;
      return {
        template: 'A',
        url,
        routingLabel: `${cityRaw}, ${stateRaw} -> ${exact}`,
        ambiguousStates: [],
        location,
      };
    }
  }

  // 2 + 3. city only (state absent, OR given but no exact city+state page).
  //        Unique nationally -> A; ambiguous -> B, unless the sender told
  //        us their state, in which case the state page (C) beats making
  //        them pick from a list that may not even contain their state.
  if (citySlug) {
    const matches = index.byCity.get(citySlug) ?? [];
    if (matches.length === 1) {
      const url = `${SITE_ORIGIN}${matches[0]!}${FORM_ANCHOR}`;
      return {
        template: 'A',
        url,
        routingLabel: `${cityRaw} -> ${matches[0]}`,
        ambiguousStates: [],
        location,
      };
    }
    if (matches.length > 1 && !index.statePages.has(stateSlug)) {
      // Ambiguous AND we have no state page to fall back to (the sender
      // named no state, or one we don't recognize). Ask which state.
      //
      // Recover the state names by inverting byCityState's composite key,
      // then map each slug back to its canonical spelling so the reply
      // body reads "Texas or California", not "texas or california".
      const statesForCity: string[] = [];
      for (const [key] of index.byCityState) {
        const [c, s] = key.split('|');
        if (c === citySlug && s && !statesForCity.includes(s)) statesForCity.push(s);
      }
      const stateNames = statesForCity.map(stateNameFromSlug);
      return {
        template: 'B',
        url: null,
        routingLabel: `${cityRaw} (ambiguous: ${stateNames.join(', ')}) -> ask which state`,
        ambiguousStates: stateNames,
        location,
      };
    }
    // No page for this city name (or ambiguous but we know the state).
    // Fall through to the state-page fallback below.
  }

  // 4. city has no page (or no city given), but state is known -> state page.
  if (stateSlug) {
    const stateUrl = index.statePages.get(stateSlug);
    if (stateUrl) {
      return {
        template: 'C',
        url: `${SITE_ORIGIN}${stateUrl}`,
        routingLabel: `no city page (state fallback: ${stateRaw}) -> ${stateUrl}`,
        ambiguousStates: [],
        location,
      };
    }
  }

  // 5. Nothing matched. This is rare — it means the sender named a state
  //    we don't have a page for (e.g. a typo'd state name that slugifies
  //    to something not in the index). Treat as location unknown.
  return {
    template: 'D',
    url: null,
    routingLabel: 'location unknown -> ask for city/state',
    ambiguousStates: [],
    location,
  };
}