// Env shape mirror for .env.example. The Phase 1 getEnv() helper will
// enforce presence/coercion; this interface documents the keys.
export interface Env {
  // PrivateEmail IMAP/SMTP
  EMAIL_IMAP_HOST: string;
  EMAIL_IMAP_PORT: number;
  EMAIL_SMTP_HOST: string;
  EMAIL_SMTP_PORT: number;
  EMAIL_USER: string;
  EMAIL_PASS: string;

  // Gemini
  GEMINI_API_KEY: string;
  GEMINI_MODEL: string;
  GEMINI_CLASSIFY_MODEL: string;

  // Neon
  DATABASE_URL: string;

  // Discord (optional in Phase 0; required by Phase 6)
  DISCORD_BOT_TOKEN: string;
  DISCORD_PUBLIC_KEY: string;
  DISCORD_CHANNEL_ID: string;

  // Cron auth
  CRON_SECRET: string;

  // Pre-filter config
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