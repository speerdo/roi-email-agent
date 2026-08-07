// lib/site/cityIndex.ts
//
// Loads the committed city-page index snapshot (assets/city-index.json)
// into two lookup maps so lib/site/resolveCityPage.ts can resolve a
// recycling_help sender's location to a real recycleoldtech.com city
// page URL without any LLM hallucination risk.
//
// The snapshot is produced by `npm run sync:cities`
// (scripts/sync-cities.ts), which fetches
// https://www.recycleoldtech.com/api/cities-data and validates the
// payload before overwriting the committed file. The site is statically
// generated, so the city set changes rarely; re-run sync:cities on each
// release or monthly.
//
// Slug parity: the site's own normalizeForUrl() (ewaste-dir/src/lib/
// supabase.ts) lowercases, maps non-alphanumerics to '-', and trims
// leading/trailing '-'. We replicate that here so a sender typing
// "St. Louis" or "O'Brien" still resolves. See slugify() below.
//
// Never fetch the endpoint at reply time — only at sync time. A bad
// deploy of the site must not be able to poison the agent's reply path.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// lib/site/ -> ../../assets/city-index.json
const INDEX_PATH = resolve(__dirname, '../../assets/city-index.json');

/** One entry from the site's /api/cities-data endpoint. */
export interface CityIndexEntry {
  city: string;
  state: string;
  url: string;
  coordinates?: { lat: number; lng: number };
}

export interface CityIndex {
  /** "{cityslug}|{stateslug}" -> full site-relative URL (e.g.
   *  "/states/pennsylvania/greencastle"). Exact-match lookup. */
  byCityState: Map<string, string>;
  /** "{cityslug}" -> array of site-relative URLs. Length 1 = unique,
   *    length > 1 = ambiguous (e.g. "Live Oak" exists in CA and TX),
   *    length 0 = no page for that city name. */
  byCity: Map<string, string[]>;
  /** "{stateslug}" -> state page URL ("/states/pennsylvania"). Built
   *    from the distinct states observed in the index, since the state
   *    page URL shape is deterministic. */
  statePages: Map<string, string>;
  /** Total record count, surfaced for diagnostics + the sync validator. */
  count: number;
}

let cached: CityIndex | null = null;

/**
 * Slugify a city or state name to match the site's normalizeForUrl().
 * Lowercase, non-alphanumerics -> '-', trim leading/trailing '-'.
 * Examples: "St. Louis" -> "st-louis", "O'Brien" -> "o-brien",
 *           "Mt. Airy" -> "mt-airy", "Greencastle" -> "greencastle".
 */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * USPS two-letter code -> canonical state name. The Gemini prompt allows
 * `location.state` to be "a 2-letter code or full name", and the most
 * common real-world phrasing is exactly that ("I'm from Greencastle,PA").
 * The site's state slugs are derived from FULL names, so "PA" slugifies to
 * "pa" and matches nothing — without this map, "Live Oak, TX" fell through
 * the exact-match rung and came back as "ambiguous (California, Texas)",
 * and "Springfield, IL" asked the sender to choose between eight states
 * that did not include their own. Normalize codes to names before
 * slugifying. See resolveCityPage().
 */
const STATE_CODE_TO_NAME: Readonly<Record<string, string>> = {
  al: 'Alabama', ak: 'Alaska', az: 'Arizona', ar: 'Arkansas', ca: 'California',
  co: 'Colorado', ct: 'Connecticut', de: 'Delaware', fl: 'Florida', ga: 'Georgia',
  hi: 'Hawaii', id: 'Idaho', il: 'Illinois', in: 'Indiana', ia: 'Iowa',
  ks: 'Kansas', ky: 'Kentucky', la: 'Louisiana', me: 'Maine', md: 'Maryland',
  ma: 'Massachusetts', mi: 'Michigan', mn: 'Minnesota', ms: 'Mississippi',
  mo: 'Missouri', mt: 'Montana', ne: 'Nebraska', nv: 'Nevada',
  nh: 'New Hampshire', nj: 'New Jersey', nm: 'New Mexico', ny: 'New York',
  nc: 'North Carolina', nd: 'North Dakota', oh: 'Ohio', ok: 'Oklahoma',
  or: 'Oregon', pa: 'Pennsylvania', ri: 'Rhode Island', sc: 'South Carolina',
  sd: 'South Dakota', tn: 'Tennessee', tx: 'Texas', ut: 'Utah', vt: 'Vermont',
  va: 'Virginia', wa: 'Washington', wv: 'West Virginia', wi: 'Wisconsin',
  wy: 'Wyoming', dc: 'District of Columbia',
};

/**
 * Normalize a sender-supplied state to its canonical full name. Accepts a
 * 2-letter USPS code ("PA", "pa", "Pa.") or a full name in any casing
 * ("pennsylvania" -> "Pennsylvania"). Returns the input trimmed when it
 * matches neither, so an unrecognized value still slugifies predictably
 * and simply fails to match the index (falling through to template D).
 */
export function canonicalStateName(state: string): string {
  const trimmed = state.trim();
  if (!trimmed) return '';
  const bare = trimmed.toLowerCase().replace(/[^a-z]/g, '');
  const byCode = STATE_CODE_TO_NAME[bare];
  if (byCode) return byCode;
  // Full name in some other casing: recover the canonical spelling from
  // the code map's values so the reply body and routing label show the
  // site's spelling rather than whatever the sender typed.
  const slug = slugify(trimmed);
  for (const name of Object.values(STATE_CODE_TO_NAME)) {
    if (slugify(name) === slug) return name;
  }
  return trimmed;
}

/**
 * Recover the canonical state name for a state slug ("pennsylvania" ->
 * "Pennsylvania"). Used to render ambiguous-city choices and the state
 * fallback in display form rather than as raw lowercase slugs.
 * Falls back to the slug itself when unrecognized.
 */
export function stateNameFromSlug(slug: string): string {
  for (const name of Object.values(STATE_CODE_TO_NAME)) {
    if (slugify(name) === slug) return name;
  }
  return slug;
}

/**
 * Load and index the committed city snapshot. Loads once at module scope
 * (cached) so repeated resolveCityPage calls don't re-read the file. The
 * file is ~370KB; parsing once is cheap and keeps reply latency flat.
 *
 * Throws if the file is missing or malformed — fail loud at startup
 * rather than silently emitting template D ("location unknown") for
 * every recycling_help request.
 */
export function loadCityIndex(): CityIndex {
  if (cached) return cached;
  cached = buildIndex(JSON.parse(readFileSync(INDEX_PATH, 'utf8')), 'city-index.json');
  return cached;
}

/** Reset the cached index — for tests that swap in a fixture. */
export function resetCityIndex(): void {
  cached = null;
}

/** Exposed for tests: load from an explicit fixture string instead of the
 *  committed file. Bypasses the filesystem entirely. */
export function loadCityIndexFromString(json: string): CityIndex {
  cached = buildIndex(JSON.parse(json), 'fixture');
  return cached;
}

/**
 * Build the lookup maps from a parsed cities-data payload. Shared by the
 * committed-file and fixture loaders so the two can't drift apart.
 * `label` only shapes the error message.
 */
function buildIndex(parsed: unknown, label: string): CityIndex {
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error(`${label} is empty or not an array`);
  }
  const entries = parsed as CityIndexEntry[];

  const byCityState = new Map<string, string>();
  const byCity = new Map<string, string[]>();
  const statePages = new Map<string, string>();

  for (const e of entries) {
    if (typeof e.city !== 'string' || typeof e.state !== 'string' || typeof e.url !== 'string') {
      continue;
    }
    const citySlug = slugify(e.city);
    const stateSlug = slugify(e.state);
    byCityState.set(`${citySlug}|${stateSlug}`, e.url);

    const arr = byCity.get(citySlug) ?? [];
    if (!arr.includes(e.url)) arr.push(e.url);
    byCity.set(citySlug, arr);

    if (!statePages.has(stateSlug)) {
      statePages.set(stateSlug, `/states/${stateSlug}`);
    }
  }

  return { byCityState, byCity, statePages, count: entries.length };
}