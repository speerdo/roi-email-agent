// Env shape mirror for .env.example, plus a runtime getEnv() helper that
// asserts presence and coerces types at cold start so missing-config
// failures are loud and early. Discord vars are optional here; Phase 6
// endpoints use a separate getDiscordEnv() that asserts them.

export interface Env {
  EMAIL_IMAP_HOST: string;
  EMAIL_IMAP_PORT: number;
  EMAIL_SMTP_HOST: string;
  EMAIL_SMTP_PORT: number;
  EMAIL_USER: string;
  EMAIL_PASS: string;

  GEMINI_API_KEY: string;
  GEMINI_MODEL: string;
  GEMINI_CLASSIFY_MODEL: string;

  DATABASE_URL: string;

  DISCORD_BOT_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_CHANNEL_ID: string;

  CRON_SECRET: string;

  AUTOMATED_FORM_SUBJECTS: string;
  AUTOMATED_FORM_FROM: string;
  AUTOMATED_FORM_BODY_MARKER: string;
  AUTOMATED_FORM_MARK_READ: boolean;
  NEWSLETTER_FROM: string;
  NEWSLETTER_SUBJECTS: string;
  NEWSLETTER_MARK_READ: boolean;
  DMARC_SUBJECTS: string;
  DMARC_FROM: string;
  DMARC_MARK_READ: boolean;
}

export interface DiscordEnv {
  DISCORD_BOT_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_CHANNEL_ID: string;
}

function required(key: string): string {
  const v = process.env[key];
  if (v === undefined || v === '') {
    throw new Error(`missing required env var: ${key}`);
  }
  return v;
}

function intFlag(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n)) throw new Error(`env var ${key} must be an integer, got: ${raw}`);
  return n;
}

function boolFlag(key: string, fallback: boolean): boolean {
  const raw = process.env[key];
  if (raw === undefined || raw === '') return fallback;
  return raw === 'true' || raw === '1';
}

let cached: Env | null = null;
let discordCached: DiscordEnv | null = null;

export function getEnv(): Env {
  if (cached) return cached;
  cached = {
    EMAIL_IMAP_HOST: required('EMAIL_IMAP_HOST'),
    EMAIL_IMAP_PORT: intFlag('EMAIL_IMAP_PORT', 993),
    EMAIL_SMTP_HOST: required('EMAIL_SMTP_HOST'),
    EMAIL_SMTP_PORT: intFlag('EMAIL_SMTP_PORT', 465),
    EMAIL_USER: required('EMAIL_USER'),
    EMAIL_PASS: required('EMAIL_PASS'),

    GEMINI_API_KEY: required('GEMINI_API_KEY'),
    GEMINI_MODEL: required('GEMINI_MODEL'),
    GEMINI_CLASSIFY_MODEL: required('GEMINI_CLASSIFY_MODEL'),

    DATABASE_URL: required('DATABASE_URL'),

    DISCORD_BOT_TOKEN: process.env.DISCORD_BOT_TOKEN ?? '',
    DISCORD_PUBLIC_KEY: process.env.DISCORD_PUBLIC_KEY ?? '',
    DISCORD_CHANNEL_ID: process.env.DISCORD_CHANNEL_ID ?? '',

    CRON_SECRET: required('CRON_SECRET'),

    AUTOMATED_FORM_SUBJECTS: required('AUTOMATED_FORM_SUBJECTS'),
    AUTOMATED_FORM_FROM: required('AUTOMATED_FORM_FROM'),
    AUTOMATED_FORM_BODY_MARKER: process.env.AUTOMATED_FORM_BODY_MARKER ?? '',
    AUTOMATED_FORM_MARK_READ: boolFlag('AUTOMATED_FORM_MARK_READ', true),
    NEWSLETTER_FROM: required('NEWSLETTER_FROM'),
    NEWSLETTER_SUBJECTS: process.env.NEWSLETTER_SUBJECTS ?? '',
    NEWSLETTER_MARK_READ: boolFlag('NEWSLETTER_MARK_READ', true),
    DMARC_SUBJECTS: required('DMARC_SUBJECTS'),
    DMARC_FROM: process.env.DMARC_FROM ?? '',
    DMARC_MARK_READ: boolFlag('DMARC_MARK_READ', true),
  };
  return cached;
}

export function getDiscordEnv(): DiscordEnv {
  if (discordCached) return discordCached;
  discordCached = {
    DISCORD_BOT_TOKEN: required('DISCORD_BOT_TOKEN'),
    DISCORD_PUBLIC_KEY: required('DISCORD_PUBLIC_KEY'),
    DISCORD_CHANNEL_ID: required('DISCORD_CHANNEL_ID'),
  };
  return discordCached;
}

/** Reset the cached env objects. For tests that mutate process.env. */
export function resetEnvCache(): void {
  cached = null;
  discordCached = null;
}

export function getCommaList(key: string): string[] {
  const raw = process.env[key] ?? '';
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function getBool(key: string, fallback: boolean): boolean {
  return boolFlag(key, fallback);
}