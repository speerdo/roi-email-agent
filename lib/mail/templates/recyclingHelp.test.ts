import { describe, it, expect } from 'vitest';
import { renderRecyclingHelp, greetingName } from './recyclingHelp.js';
import type { ResolvedCityPage } from '../../site/resolveCityPage.js';

function resolved(overrides: Partial<ResolvedCityPage>): ResolvedCityPage {
  return {
    template: 'A',
    url: 'https://www.recycleoldtech.com/states/pennsylvania/greencastle#recycling-request-form',
    routingLabel: 'Greencastle, PA -> /states/pennsylvania/greencastle',
    ambiguousStates: [],
    location: { city: 'Greencastle', state: 'PA', zip: null },
    ...overrides,
  };
}

describe('renderRecyclingHelp', () => {
  it('template A: city page resolved, form-first, reply-second', () => {
    const body = renderRecyclingHelp({
      firstName: 'Kevin',
      resolved: resolved({}),
      location: { city: 'Greencastle', state: 'PA', zip: null },
    });
    expect(body).toContain('Hi Kevin');
    expect(body).toContain('https://www.recycleoldtech.com/states/pennsylvania/greencastle#recycling-request-form');
    expect(body).toContain('Fill out the short form');
    expect(body).toContain('Or just reply');
    // No sign-off: lib/mail/signature.ts appends the real one at send time.
    expect(body).not.toContain('RecycleOldTech / Adam');
    // No em dashes (house style).
    expect(body).not.toMatch(/--|—/);
  });

  it('template A: null firstName falls back to bare "Hi"', () => {
    const body = renderRecyclingHelp({
      firstName: null,
      resolved: resolved({}),
      location: { city: 'Greencastle', state: 'PA', zip: null },
    });
    expect(body).toMatch(/^Hi,/);
  });

  it('template B: ambiguous city, asks which state, no city URL', () => {
    const body = renderRecyclingHelp({
      firstName: 'Sam',
      resolved: resolved({
        template: 'B',
        url: null,
        routingLabel: 'Live Oak (ambiguous: California, Texas) -> ask which state',
        // Display names, not slugs — resolveCityPage maps them back so the
        // reply body never shows "california or texas" to a human.
        ambiguousStates: ['California', 'Texas'],
        location: { city: 'Live Oak', state: null, zip: null },
      }),
      location: { city: 'Live Oak', state: null, zip: null },
    });
    expect(body).toContain('Hi Sam');
    expect(body).toContain('more than one Live Oak');
    expect(body).toContain('Let us know which state you are in (California or Texas)');
    expect(body).not.toContain('Fill out the short form');
  });

  it('template C: state-page fallback, no form anchor in URL', () => {
    const body = renderRecyclingHelp({
      firstName: 'Pat',
      resolved: resolved({
        template: 'C',
        url: 'https://www.recycleoldtech.com/states/pennsylvania',
        routingLabel: 'no city page (state fallback: PA) -> /states/pennsylvania',
        location: { city: 'Nowhereville', state: 'PA', zip: null },
      }),
      location: { city: 'Nowhereville', state: 'PA', zip: null },
    });
    expect(body).toContain('Hi Pat');
    expect(body).toContain('https://www.recycleoldtech.com/states/pennsylvania');
    expect(body).not.toContain('#recycling-request-form');
    expect(body).toContain('Pick the closest city');
  });

  it('template D: no location, asks for city/state or zip', () => {
    const body = renderRecyclingHelp({
      firstName: null,
      resolved: resolved({
        template: 'D',
        url: null,
        routingLabel: 'location unknown -> ask for city/state',
        location: null,
      }),
      location: null,
    });
    expect(body).toMatch(/^Hi,/);
    expect(body).toContain('Tell us your city and state');
    expect(body).not.toContain('RecycleOldTech / Adam');
  });
});
describe('greetingName', () => {
  it('prefers the body-extracted name over the From display name', () => {
    // The canonical Web3Forms shape: header says "Notifications", the body
    // says who actually wrote in.
    expect(greetingName('Fred Buczynski', 'Notifications')).toBe('Fred');
  });

  it('reduces a full name to a first name', () => {
    expect(greetingName('Fred Buczynski', null)).toBe('Fred');
    expect(greetingName(null, 'Jane Doe')).toBe('Jane');
  });

  it('rejects notification-bot display names rather than greeting them', () => {
    for (const bot of ['Notifications', 'notifications', 'MAILER-DAEMON', 'no-reply', 'Web3Forms']) {
      expect(greetingName(null, bot)).toBeNull();
    }
  });

  it('rejects an address-shaped display name', () => {
    expect(greetingName(null, 'jane@example.com')).toBeNull();
  });

  it('returns null when neither source has a usable name', () => {
    expect(greetingName(null, null)).toBeNull();
    expect(greetingName('', '   ')).toBeNull();
  });

  it('strips trailing punctuation from the first token', () => {
    expect(greetingName('Fred,', null)).toBe('Fred');
  });

  it('falls through to From when sender_name is a bot name', () => {
    expect(greetingName('Notifications', 'Jane Doe')).toBe('Jane');
  });
});

describe('renderRecyclingHelp greeting integration', () => {
  it('opens with a bare "Hi" when no name is available', () => {
    const body = renderRecyclingHelp({
      firstName: greetingName(null, 'Notifications'),
      resolved: resolved({}),
      location: { city: 'Greencastle', state: 'PA', zip: null },
    });
    expect(body.startsWith('Hi,')).toBe(true);
    expect(body).not.toContain('Notifications');
  });

  it('names the resolved place in template A so the reader can verify it', () => {
    const body = renderRecyclingHelp({
      firstName: 'Kevin',
      resolved: resolved({}),
      location: { city: 'Greencastle', state: 'PA', zip: null },
    });
    // State code expanded to its canonical name for the reader.
    expect(body).toContain('our Greencastle, Pennsylvania page');
  });
});
