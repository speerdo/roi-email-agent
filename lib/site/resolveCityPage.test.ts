import { describe, it, expect, beforeAll } from 'vitest';
import { loadCityIndexFromString, slugify } from './cityIndex.js';
import { resolveCityPage } from './resolveCityPage.js';

// Hermetic fixture: covers the resolution ladder without depending on
// the 370KB committed snapshot. Includes a unique city, an ambiguous
// city (exists in 2 states), a city with no page, and a state with no
// matching city — every ladder branch.
const FIXTURE = JSON.stringify([
  { city: 'Greencastle', state: 'Pennsylvania', url: '/states/pennsylvania/greencastle' },
  { city: 'Perkasie', state: 'Pennsylvania', url: '/states/pennsylvania/perkasie' },
  { city: 'Live Oak', state: 'California', url: '/states/california/live-oak' },
  { city: 'Live Oak', state: 'Texas', url: '/states/texas/live-oak' },
  { city: 'Overland Park', state: 'Kansas', url: '/states/kansas/overland-park' },
  { city: 'Worcester', state: 'Massachusetts', url: '/states/massachusetts/worcester' },
]);

beforeAll(() => {
  loadCityIndexFromString(FIXTURE);
});

describe('slugify', () => {
  it('lowercases and maps non-alphanumerics to hyphens', () => {
    expect(slugify('Greencastle')).toBe('greencastle');
    expect(slugify('St. Louis')).toBe('st-louis');
    expect(slugify("O'Brien")).toBe('o-brien');
    expect(slugify('Mt. Airy')).toBe('mt-airy');
    expect(slugify('Live Oak')).toBe('live-oak');
  });
  it('trims leading/trailing hyphens', () => {
    expect(slugify('--foo--')).toBe('foo');
    expect(slugify('  spaced  ')).toBe('spaced');
  });
});

describe('resolveCityPage', () => {
  it('case 1: city + state exact match -> template A with city-page URL + form anchor', () => {
    const r = resolveCityPage({ city: 'Greencastle', state: 'PA', zip: null });
    expect(r.template).toBe('A');
    expect(r.url).toBe('https://www.recycleoldtech.com/states/pennsylvania/greencastle#recycling-request-form');
    expect(r.routingLabel).toContain('Greencastle');
    expect(r.routingLabel).toContain('/states/pennsylvania/greencastle');
  });

  it('case 1: full state name also matches (slug parity)', () => {
    const r = resolveCityPage({ city: 'Greencastle', state: 'Pennsylvania', zip: null });
    expect(r.template).toBe('A');
    expect(r.url).toContain('/states/pennsylvania/greencastle');
  });

  it('case 2: city only, unique across all states -> template A', () => {
    const r = resolveCityPage({ city: 'Perkasie', state: null, zip: null });
    expect(r.template).toBe('A');
    expect(r.url).toContain('/states/pennsylvania/perkasie');
    expect(r.url).toContain('#recycling-request-form');
  });

  it('case 3: city only, ambiguous -> template B with candidate states in display form', () => {
    const r = resolveCityPage({ city: 'Live Oak', state: null, zip: null });
    expect(r.template).toBe('B');
    expect(r.url).toBeNull();
    // Display names, not slugs — these get read by the recipient in the
    // reply body ("California or Texas", never "california or texas").
    expect(r.ambiguousStates).toEqual(['California', 'Texas']);
    expect(r.routingLabel).toContain('ambiguous');
  });

  it('case 3: city + WRONG state prefers that state page over asking to pick', () => {
    // "Live Oak, KS" doesn't exist and "Live Oak" is ambiguous (CA + TX),
    // but the sender DID tell us Kansas. Asking them to choose between
    // California and Texas would offer a list not containing their own
    // state; the Kansas state page is the useful answer.
    const r = resolveCityPage({ city: 'Live Oak', state: 'Kansas', zip: null });
    expect(r.template).toBe('C');
    expect(r.url).toBe('https://www.recycleoldtech.com/states/kansas');
  });

  it('resolves a 2-letter state code, which the prompt explicitly allows', () => {
    // The index's state slugs come from full names, so "TX" has to be
    // expanded before slugifying. Without that, this exact-match rung
    // misses and an unambiguous location is demoted to "ambiguous".
    const r = resolveCityPage({ city: 'Live Oak', state: 'TX', zip: null });
    expect(r.template).toBe('A');
    expect(r.url).toBe('https://www.recycleoldtech.com/states/texas/live-oak#recycling-request-form');
    expect(r.routingLabel).toContain('Texas');
  });

  it('resolves a lowercase / punctuated state code', () => {
    expect(resolveCityPage({ city: 'Greencastle', state: 'pa', zip: null }).url)
      .toBe('https://www.recycleoldtech.com/states/pennsylvania/greencastle#recycling-request-form');
    expect(resolveCityPage({ city: 'Greencastle', state: 'Pa.', zip: null }).template).toBe('A');
  });

  it('state code alone (no city) -> template C state page', () => {
    const r = resolveCityPage({ city: null, state: 'PA', zip: null });
    expect(r.template).toBe('C');
    expect(r.url).toBe('https://www.recycleoldtech.com/states/pennsylvania');
  });

  it('case 4: city has no page, state known -> template C with state page URL (no form anchor)', () => {
    const r = resolveCityPage({ city: 'Nowhereville', state: 'Pennsylvania', zip: null });
    expect(r.template).toBe('C');
    expect(r.url).toBe('https://www.recycleoldtech.com/states/pennsylvania');
    expect(r.url).not.toContain('#recycling-request-form');
    expect(r.routingLabel).toContain('state fallback');
  });

  it('case 4: no city given, state known -> template C', () => {
    const r = resolveCityPage({ city: null, state: 'Kansas', zip: null });
    expect(r.template).toBe('C');
    expect(r.url).toBe('https://www.recycleoldtech.com/states/kansas');
  });

  it('case 5: no location at all -> template D, null URL', () => {
    const r = resolveCityPage(null);
    expect(r.template).toBe('D');
    expect(r.url).toBeNull();
    expect(r.routingLabel).toContain('location unknown');
  });

  it('case 5: all-empty location -> template D', () => {
    const r = resolveCityPage({ city: '', state: '', zip: '' });
    expect(r.template).toBe('D');
    expect(r.url).toBeNull();
  });

  it('zip-only input -> template D in v1 (no ZIP -> city table yet)', () => {
    const r = resolveCityPage({ city: null, state: null, zip: '17236' });
    expect(r.template).toBe('D');
    expect(r.url).toBeNull();
  });

  it('city with no page AND no state given -> template D (cannot fall back to a state page)', () => {
    const r = resolveCityPage({ city: 'Nowhereville', state: null, zip: null });
    expect(r.template).toBe('D');
    expect(r.url).toBeNull();
  });

  it('state that does not exist in the index -> template D (slug does not match)', () => {
    const r = resolveCityPage({ city: null, state: 'FakeState', zip: null });
    expect(r.template).toBe('D');
    expect(r.url).toBeNull();
  });
});