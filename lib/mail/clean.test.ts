import { describe, it, expect } from 'vitest';
import { cleanBody, parseFromHeader } from './clean.js';

describe('cleanBody', () => {
  it('returns short bodies unchanged', () => {
    expect(cleanBody('hello world')).toBe('hello world');
  });

  it('strips "On <date> ... wrote:" quoted history and everything after', () => {
    const body = 'Hi Adam,\n\nCan you list us?\n\nOn Tue, Jun 3, 2025 at 9:00 AM Someone <s@x.com> wrote:\n> previous message\n> more quote';
    expect(cleanBody(body)).toBe('Hi Adam,\n\nCan you list us?');
  });

  it('strips multi-line "On ... wrote:" blocks (email address wrapped)', () => {
    // Real-world example from the live mailbox: the "On <date> ..." line
    // wraps the recipient's email across two lines before "wrote:".
    const body =
      'hi hi\n\nOn Wed, Jul 2, 2025 at 1:15 PM hello@recycleoldtech.com\nhello@recycleoldtech.com <hello@recycleoldtech.com> wrote:\n> previous';
    expect(cleanBody(body)).toBe('hi hi');
  });

  it('strips RFC 3676 signature delimiter and everything below', () => {
    const body = 'Real content here\n\n-- \nAdam Speer\nRecycleOldTech';
    expect(cleanBody(body)).toBe('Real content here');
  });

  it('strips common sign-off phrases', () => {
    const body = 'Please list our business.\n\nBest regards,\nJane';
    expect(cleanBody(body)).toBe('Please list our business.');
  });

  it('strips "Sent from my iPhone" signatures', () => {
    const body = 'Quick reply.\n\nSent from my iPhone';
    expect(cleanBody(body)).toBe('Quick reply.');
  });

  it('strips inline > quoted lines', () => {
    const body = 'Question?\n> old question from last week\n> more context\nMy new answer.';
    expect(cleanBody(body)).toBe('Question?\nMy new answer.');
  });

  it('collapses whitespace runs', () => {
    const body = 'too    much    space\n\n\n\n\n\nempty lines between';
    expect(cleanBody(body)).toBe('too much space\n\nempty lines between');
  });

  it('truncates at a word boundary near maxChars', () => {
    const words = Array.from({ length: 500 }, (_, i) => `word${i}`).join(' ');
    const out = cleanBody(words, 100);
    expect(out.length).toBeLessThanOrEqual(110); // word-boundary slack
    expect(out.endsWith('…')).toBe(true);
    // The ellipsis must immediately follow a complete word (no partial word).
    const beforeEllipsis = out.slice(0, -1);
    expect(beforeEllipsis.endsWith(' ')).toBe(false);
    // And the original word that the cut is inside of should not appear
    // truncated at the boundary.
    expect(beforeEllipsis).toMatch(/word\d+$/);
  });

  it('hard-cuts when no space is found near maxChars', () => {
    // One continuous run of characters with no spaces, longer than maxChars.
    const body = 'a'.repeat(5000);
    const out = cleanBody(body, 100);
    // Falls back to hard cut at maxChars and adds the ellipsis.
    expect(out.length).toBe(101); // 100 + 1 for …
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('parseFromHeader', () => {
  it('parses quoted-name + angled address', () => {
    expect(parseFromHeader('"Jane Doe" <jane@example.com>')).toEqual({
      address: 'jane@example.com',
      name: 'Jane Doe',
    });
  });

  it('parses unquoted-name + angled address', () => {
    expect(parseFromHeader('Jane Doe <jane@example.com>')).toEqual({
      address: 'jane@example.com',
      name: 'Jane Doe',
    });
  });

  it('parses bare address', () => {
    expect(parseFromHeader('jane@example.com')).toEqual({ address: 'jane@example.com' });
  });

  it('parses address-with-comment form', () => {
    expect(parseFromHeader('jane@example.com (Jane Doe)')).toEqual({
      address: 'jane@example.com',
      name: 'Jane Doe',
    });
  });

  it('returns empty address for empty/undefined input', () => {
    expect(parseFromHeader('')).toEqual({ address: '' });
    expect(parseFromHeader(undefined)).toEqual({ address: '' });
    expect(parseFromHeader(null)).toEqual({ address: '' });
  });
});