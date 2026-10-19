import { describe, it, expect, afterEach } from 'vitest';
import { getBrandEnv, requireBrandEnv } from './env.js';
import { DOWNTOWNDRY_BRAND } from './downtowndry.js';
import { EBIKELOCAL_BRAND } from './ebikelocal.js';
import { ROI_BRAND } from './roi.js';
import { tryGetBrand, syncKeyFor } from './index.js';

const ORIGINAL = { ...process.env };

describe('per-brand env (getBrandEnv)', () => {
  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it('ROI uses the shared env vars (getEnv) — behavior unchanged', () => {
    // In a bare env getEnv() fails on the first missing required var.
    // That's the point: ROI has no graceful "not configured" path, exactly
    // as before multi-brand.
    expect(() => getBrandEnv(ROI_BRAND)).toThrow(/missing required env var/);
  });

  it('DD resolves its DD_* vars when all three are present', () => {
    process.env.DD_EMAIL_USER = 'hello@downtowndry.bar';
    process.env.DD_EMAIL_PASS = 'secret';
    process.env.DD_DISCORD_CHANNEL_ID = '1234567890';
    const env = getBrandEnv(DOWNTOWNDRY_BRAND);
    expect(env).toEqual({
      emailUser: 'hello@downtowndry.bar',
      emailPass: 'secret',
      discordChannelId: '1234567890',
    });
  });

  it.each(['DD_EMAIL_USER', 'DD_EMAIL_PASS', 'DD_DISCORD_CHANNEL_ID'])(
    'DD is unconfigured (null) when %s is missing',
    (key) => {
      process.env.DD_EMAIL_USER = 'hello@downtowndry.bar';
      process.env.DD_EMAIL_PASS = 'secret';
      process.env.DD_DISCORD_CHANNEL_ID = '1234567890';
      delete process.env[key];
      expect(getBrandEnv(DOWNTOWNDRY_BRAND)).toBeNull();
    },
  );

  it('requireBrandEnv throws with the brand id for an unconfigured brand', () => {
    delete process.env.DD_EMAIL_USER;
    delete process.env.DD_EMAIL_PASS;
    delete process.env.DD_DISCORD_CHANNEL_ID;
    expect(() => requireBrandEnv(DOWNTOWNDRY_BRAND)).toThrow(/downtowndry/);
  });
});

describe('poll brand routing (tryGetBrand + syncKeyFor)', () => {
  it('defaults to ROI when the param is absent', () => {
    expect(tryGetBrand(undefined)?.id).toBe('roi');
  });

  it('resolves a known brand id', () => {
    expect(tryGetBrand('downtowndry')?.id).toBe('downtowndry');
  });

  it('returns null on an unknown id (caller 400s)', () => {
    expect(tryGetBrand('nope')).toBeNull();
  });

  it('sync keys are scoped per brand so cursors never collide', () => {
    expect(syncKeyFor(ROI_BRAND)).toBe('roi:INBOX');
    expect(syncKeyFor(DOWNTOWNDRY_BRAND)).toBe('downtowndry:INBOX');
    expect(syncKeyFor(ROI_BRAND)).not.toBe(syncKeyFor(DOWNTOWNDRY_BRAND));
  });
});

describe('eBikeLocal env (EBL_*)', () => {
  it('resolves EBL_* vars and skips cleanly when one is missing', () => {
    process.env.EBL_EMAIL_USER = 'hello@ebikelocal.com';
    process.env.EBL_EMAIL_PASS = 'secret';
    process.env.EBL_DISCORD_CHANNEL_ID = '1234567890';
    expect(getBrandEnv(EBIKELOCAL_BRAND)?.emailUser).toBe('hello@ebikelocal.com');
    delete process.env.EBL_EMAIL_PASS;
    expect(getBrandEnv(EBIKELOCAL_BRAND)).toBeNull();
    delete process.env.EBL_EMAIL_USER;
    delete process.env.EBL_DISCORD_CHANNEL_ID;
  });

  it('has its own poll cursor key', () => {
    expect(tryGetBrand('ebikelocal')?.id).toBe('ebikelocal');
    expect(syncKeyFor(EBIKELOCAL_BRAND)).toBe('ebikelocal:INBOX');
  });
});
