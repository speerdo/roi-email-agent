import { describe, it, expect } from 'vitest';
import { parseClassifyResult } from './index.js';

describe('parseClassifyResult', () => {
  it('parses a well-formed listing_request with all classic fields', () => {
    const r = parseClassifyResult(
      JSON.stringify({
        category: 'listing_request',
        should_reply: true,
        draft_reply: 'Hi, head to https://recycleoldtech.com/claims',
        reason: 'recycler wants to be listed',
      sender_name: null,
      }),
    );
    expect(r).toEqual({
      category: 'listing_request',
      should_reply: true,
      draft_reply: 'Hi, head to https://recycleoldtech.com/claims',
      reason: 'recycler wants to be listed',
      sender_name: null,
      location: null,
      items: null,
      help_type: null,
    });
  });

  it('parses a recycling_help with location, items, help_type', () => {
    const r = parseClassifyResult(
      JSON.stringify({
        category: 'recycling_help',
        should_reply: true,
        draft_reply: '',
        reason: 'person wants to recycle a TV',
        location: { city: 'Greencastle', state: 'PA', zip: null },
        items: ['TVs/Monitors'],
        help_type: 'Drop off at center',
      }),
    );
    expect(r.category).toBe('recycling_help');
    expect(r.should_reply).toBe(true);
    expect(r.draft_reply).toBe('');
    expect(r.location).toEqual({ city: 'Greencastle', state: 'PA', zip: null });
    expect(r.items).toEqual(['TVs/Monitors']);
    expect(r.help_type).toBe('Drop off at center');
  });

  it('recycling_help with no location stated -> location null (template D fallback)', () => {
    const r = parseClassifyResult(
      JSON.stringify({
        category: 'recycling_help',
        should_reply: true,
        draft_reply: '',
        reason: 'wants to recycle, no location',
      }),
    );
    expect(r.category).toBe('recycling_help');
    expect(r.location).toBeNull();
    expect(r.items).toBeNull();
    expect(r.help_type).toBeNull();
  });

  it('strips markdown fences around the JSON', () => {
    const r = parseClassifyResult(
      '```json\n{"category":"spam","should_reply":false,"draft_reply":"","reason":"cold pitch"}\n```',
    );
    expect(r.category).toBe('spam');
    expect(r.should_reply).toBe(false);
  });

  it('tolerates leading/trailing prose around the JSON object', () => {
    const r = parseClassifyResult(
      'Here is the classification:\n{"category":"other","should_reply":false,"draft_reply":"","reason":"ambiguous"}\nThanks!',
    );
    expect(r.category).toBe('other');
  });

  it('falls back to other/should_reply=false on no JSON', () => {
    const r = parseClassifyResult('not json at all');
    expect(r.category).toBe('other');
    expect(r.should_reply).toBe(false);
    expect(r.reason).toMatch(/parse_failed/);
    expect(r.location).toBeNull();
  });

  it('falls back to other on invalid JSON', () => {
    const r = parseClassifyResult('{not valid json}');
    expect(r.category).toBe('other');
    expect(r.reason).toMatch(/parse_failed/);
  });

  it('coerces an unknown category to other', () => {
    const r = parseClassifyResult(
      JSON.stringify({ category: 'bogus_category', should_reply: true, draft_reply: 'hi' }),
    );
    expect(r.category).toBe('other');
  });

  it('treats should_reply strictly true (no truthy coercion)', () => {
    const r = parseClassifyResult(
      JSON.stringify({ category: 'support', should_reply: 'yes', draft_reply: '' }),
    );
    expect(r.should_reply).toBe(false);
  });

  it('tolerates garbage location field without throwing', () => {
    const r = parseClassifyResult(
      JSON.stringify({
        category: 'recycling_help',
        should_reply: true,
        draft_reply: '',
        reason: 'x',
        location: 'not an object',
        items: 'not an array',
        help_type: 42,
      }),
    );
    expect(r.location).toBeNull();
    expect(r.items).toBeNull();
    expect(r.help_type).toBeNull();
  });

  it('strips whitespace in location fields', () => {
    const r = parseClassifyResult(
      JSON.stringify({
        category: 'recycling_help',
        should_reply: true,
        draft_reply: '',
        reason: 'x',
        location: { city: '  Greencastle  ', state: '  PA  ', zip: '  17236  ' },
      }),
    );
    expect(r.location).toEqual({ city: 'Greencastle', state: 'PA', zip: '17236' });
  });

  it('location with all-empty fields resolves to null', () => {
    const r = parseClassifyResult(
      JSON.stringify({
        category: 'recycling_help',
        should_reply: true,
        draft_reply: '',
        reason: 'x',
        location: { city: '', state: '', zip: '' },
      }),
    );
    expect(r.location).toBeNull();
  });

  it('items with non-string elements filters them out', () => {
    const r = parseClassifyResult(
      JSON.stringify({
        category: 'recycling_help',
        should_reply: true,
        draft_reply: '',
        reason: 'x',
        items: ['TVs', 42, null, 'computers', ''],
      }),
    );
    expect(r.items).toEqual(['TVs', 'computers']);
  });
});