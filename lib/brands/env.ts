// lib/brands/env.ts
//
// Per-brand credentials and Discord routing. Host/port, Gemini, the DB,
// the bot token, the public key and CRON_SECRET are SHARED (types/env.ts);
// only the mailbox credentials and the approval channel vary per brand.
//
// ROI reads its current env vars (EMAIL_USER / EMAIL_PASS /
// DISCORD_CHANNEL_ID) and throws when missing — behavior unchanged.
// DowntownDry reads DD_EMAIL_USER / DD_EMAIL_PASS / DD_DISCORD_CHANNEL_ID
// and returns null when any is missing, so the poll can return a clean
// "not configured" skip instead of a 500.

import { getEnv } from '../env.js';
import type { BrandProfile } from './types.js';

export interface BrandEnv {
  emailUser: string;
  emailPass: string;
  discordChannelId: string;
}

/**
 * Resolve the per-brand credentials, or null when the brand is not
 * configured. ROI (envPrefix '') throws via getEnv() when its vars are
 * missing (same as before multi-brand); prefixed brands return null so
 * callers can skip cleanly.
 */
export function getBrandEnv(brand: BrandProfile): BrandEnv | null {
  if (brand.envPrefix === '') {
    const env = getEnv();
    return {
      emailUser: env.EMAIL_USER,
      emailPass: env.EMAIL_PASS,
      discordChannelId: env.DISCORD_CHANNEL_ID,
    };
  }
  const p = brand.envPrefix;
  const user = process.env[`${p}_EMAIL_USER`];
  const pass = process.env[`${p}_EMAIL_PASS`];
  const channel = process.env[`${p}_DISCORD_CHANNEL_ID`];
  if (!user || !pass || !channel) return null;
  return { emailUser: user, emailPass: pass, discordChannelId: channel };
}

/** Required variant — throws with a brand-scoped message when unconfigured. */
export function requireBrandEnv(brand: BrandProfile): BrandEnv {
  const benv = getBrandEnv(brand);
  if (!benv) {
    throw new Error(
      `brand ${brand.id} is not configured: ${brand.envPrefix}_EMAIL_USER, ${brand.envPrefix}_EMAIL_PASS and ${brand.envPrefix}_DISCORD_CHANNEL_ID are all required`,
    );
  }
  return benv;
}
