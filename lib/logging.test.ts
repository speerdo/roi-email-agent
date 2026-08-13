import { describe, it, expect } from 'vitest';
import { newRunSummary, recordError, toDiscordLine, formatErrors } from './logging.js';

function summaryWith(errors: Array<{ stage: string; message: string; uid?: number }>) {
  const s = newRunSummary('hello@recycleoldtech.com/INBOX', 'incremental', 1483);
  for (const e of errors) recordError(s, e);
  return s;
}

describe('toDiscordLine', () => {
  it('inlines the error text instead of only counting it', () => {
    // The 2026-08-13 PrivateEmail outage: the old line read
    // "⚠️ 1 errors" and told the reader nothing actionable.
    const s = summaryWith([
      { stage: 'imap', message: 'connect ETIMEDOUT 198.54.122.135:993' },
    ]);
    const line = toDiscordLine(s);
    expect(line).toContain('processed=0');
    expect(line).toContain('imap: connect ETIMEDOUT 198.54.122.135:993');
  });

  it('says "1 error", not "1 errors"', () => {
    const line = toDiscordLine(summaryWith([{ stage: 'imap', message: 'boom' }]));
    expect(line).toContain('⚠️ 1 error —');
    expect(line).not.toContain('1 errors');
  });

  it('omits the error section entirely on a clean run', () => {
    const s = newRunSummary('hello@recycleoldtech.com/INBOX', 'incremental', 1483);
    s.processed = 4;
    s.byCategory = { support: 3, spam: 1 };
    const line = toDiscordLine(s);
    expect(line).toBe(
      '**incremental** hello@recycleoldtech.com/INBOX — processed=4 [support=3, spam=1]',
    );
  });
});

describe('formatErrors', () => {
  it('returns empty string when there are no errors', () => {
    expect(formatErrors([])).toBe('');
  });

  it('attributes an error to its UID when it has one', () => {
    expect(formatErrors([{ stage: 'classify', message: 'Gemini 429', uid: 1490 }])).toBe(
      'classify (uid 1490): Gemini 429',
    );
  });

  it('collapses identical errors into a count rather than repeating them', () => {
    const errors = Array.from({ length: 10 }, () => ({
      stage: 'classify',
      message: 'Gemini 429 rate limited',
    }));
    expect(formatErrors(errors)).toBe('classify: Gemini 429 rate limited (×10)');
  });

  it('shows at most three distinct errors and counts the rest', () => {
    const errors = ['a', 'b', 'c', 'd', 'e'].map((m) => ({ stage: 'parse', message: m }));
    const out = formatErrors(errors);
    expect(out).toBe('parse: a; parse: b; parse: c; +2 more');
  });

  it('truncates a long message so the Discord limit is never at risk', () => {
    const out = formatErrors([{ stage: 'db', message: 'x'.repeat(500) }]);
    expect(out.length).toBeLessThan(200);
    expect(out.endsWith('…')).toBe(true);
  });

  it('flattens newlines so a stack trace cannot break the one-line format', () => {
    const out = formatErrors([{ stage: 'db', message: 'failed\n  at foo\n  at bar' }]);
    expect(out).toBe('db: failed at foo at bar');
  });
});
