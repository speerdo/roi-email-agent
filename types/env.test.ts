import { describe, it, expect, beforeEach } from 'vitest';
import { getEnv, getDiscordEnv, getCommaList, getBool, resetEnvCache } from '../types/env.js';

const baseline = {
  EMAIL_IMAP_HOST: 'mail.privateemail.com',
  EMAIL_IMAP_PORT: '993',
  EMAIL_SMTP_HOST: 'mail.privateemail.com',
  EMAIL_SMTP_PORT: '465',
  EMAIL_USER: 'hello@example.com',
  EMAIL_PASS: 'pw',
  GEMINI_API_KEY: 'k',
  GEMINI_MODEL: 'gemini-2.5-flash',
  GEMINI_CLASSIFY_MODEL: 'gemini-2.5-flash',
  DATABASE_URL: 'postgres://u:p@h/db',
  CRON_SECRET: 's',
  AUTOMATED_FORM_SUBJECTS: 'Recycling request from,Another prefix',
  AUTOMATED_FORM_FROM: 'notify@web3forms.com',
  AUTOMATED_FORM_MARK_READ: 'true',
  NEWSLETTER_FROM: 'example.com',
  NEWSLETTER_MARK_READ: 'false',
  DMARC_SUBJECTS: 'Report domain:,Report Domain:',
  DMARC_MARK_READ: 'true',
};

function withEnv(overrides: Record<string, string | undefined> = {}): void {
  resetEnvCache();
  // Wipe first so stale values from a prior test don't bleed through.
  for (const k of Object.keys(baseline)) delete process.env[k];
  for (const [k, v] of Object.entries(baseline)) process.env[k] = v;
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(() => withEnv());

describe('getEnv', () => {
  it('parses all required keys and coerces types', () => {
    const env = getEnv();
    expect(env.EMAIL_IMAP_PORT).toBe(993);
    expect(env.EMAIL_SMTP_PORT).toBe(465);
    expect(env.AUTOMATED_FORM_MARK_READ).toBe(true);
    expect(env.NEWSLETTER_MARK_READ).toBe(false);
    expect(env.DMARC_MARK_READ).toBe(true);
  });

  it('uses default port fallbacks when port env is empty', () => {
    withEnv({ EMAIL_IMAP_PORT: '', EMAIL_SMTP_PORT: '' });
    const env = getEnv();
    expect(env.EMAIL_IMAP_PORT).toBe(993);
    expect(env.EMAIL_SMTP_PORT).toBe(465);
  });

  it('throws on a missing required key', () => {
    withEnv({ EMAIL_PASS: undefined });
    expect(() => getEnv()).toThrowError(/EMAIL_PASS/);
  });

  it('throws on a non-integer port', () => {
    withEnv({ EMAIL_IMAP_PORT: '99.5' });
    expect(() => getEnv()).toThrowError(/EMAIL_IMAP_PORT/);
  });

  it('leaves Discord vars as empty strings when unset', () => {
    const env = getEnv();
    expect(env.DISCORD_BOT_TOKEN).toBe('');
    expect(env.DISCORD_PUBLIC_KEY).toBe('');
    expect(env.DISCORD_CHANNEL_ID).toBe('');
  });

  it('caches across calls (same instance returned)', () => {
    const a = getEnv();
    const b = getEnv();
    expect(a).toBe(b);
  });
});

describe('getDiscordEnv', () => {
  it('throws when Discord vars are missing', () => {
    expect(() => getDiscordEnv()).toThrowError(/DISCORD_BOT_TOKEN/);
  });

  it('returns all three when set', () => {
    withEnv({
      DISCORD_BOT_TOKEN: 'tok',
      DISCORD_PUBLIC_KEY: 'pk',
      DISCORD_CHANNEL_ID: 'cid',
    });
    expect(getDiscordEnv()).toEqual({
      DISCORD_BOT_TOKEN: 'tok',
      DISCORD_PUBLIC_KEY: 'pk',
      DISCORD_CHANNEL_ID: 'cid',
    });
  });
});

describe('getCommaList', () => {
  it('splits and trims', () => {
    expect(getCommaList('AUTOMATED_FORM_SUBJECTS')).toEqual([
      'Recycling request from',
      'Another prefix',
    ]);
  });

  it('returns empty array for empty/missing values', () => {
    expect(getCommaList('NEWSLETTER_SUBJECTS')).toEqual([]);
    expect(getCommaList('DOES_NOT_EXIST')).toEqual([]);
  });
});

describe('getBool', () => {
  it('reads true/1/false/anything-else as false', () => {
    expect(getBool('AUTOMATED_FORM_MARK_READ', false)).toBe(true);
    expect(getBool('NEWSLETTER_MARK_READ', true)).toBe(false);
  });

  it('falls back when unset', () => {
    expect(getBool('UNSET_KEY', true)).toBe(true);
    expect(getBool('UNSET_KEY', false)).toBe(false);
  });
});