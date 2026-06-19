import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import { getEnv } from './env.js';
import { appendSent } from './imap.js';

// ---- Public types ---------------------------------------------------------

export interface SendReplyInput {
  to: string;
  subject: string;
  text: string;
  /** Original Message-ID header, for threading (In-Reply-To). */
  inReplyTo?: string;
  /** References header chain, for threading. */
  references?: string;
}

export interface SendReplyResult {
  messageId: string | undefined;
  appendedToSent: boolean;
}

// ---- Transport lifecycle --------------------------------------------------

/**
 * Created fresh on every call (no shared pool) — serverless-friendly, since
 * a pooled connection cached at module scope can go stale across cold starts.
 */
function getTransport(): Transporter {
  const env = getEnv();
  return nodemailer.createTransport({
    host: env.EMAIL_SMTP_HOST,
    port: env.EMAIL_SMTP_PORT,
    secure: true, // port 465 is implicit TLS
    auth: { user: env.EMAIL_USER, pass: env.EMAIL_PASS },
  });
}

// ---- Public API -----------------------------------------------------------

/**
 * Send a reply via PrivateEmail SMTP, threaded to the inbound message via
 * In-Reply-To + References headers. Per plan §11, the display name is
 * "RecycleOldTech" and the from address is EMAIL_USER.
 *
 * After a successful send, attempts to append the sent raw message to the
 * IMAP `Sent` folder (Phase 9 nice-to-have; currently a stub that logs
 * "not implemented"). The append failure is non-fatal — the email was
 * already sent, so we return `appendedToSent: false` and continue.
 */
export async function sendReply(input: SendReplyInput): Promise<SendReplyResult> {
  const env = getEnv();
  const transport = getTransport();

  const from = `"RecycleOldTech" <${env.EMAIL_USER}>`;

  const info = await transport.sendMail({
    from,
    to: input.to,
    subject: input.subject,
    text: input.text,
    inReplyTo: input.inReplyTo,
    references: input.references,
  });

  // Best-effort mirror to IMAP Sent folder. Phase 9 will implement
  // appendSent() for real; until then it's a no-op that logs.
  let appendedToSent = false;
  try {
    await appendSent(info.messageId ?? '');
    // Once Phase 9 implements appendSent, the call above actually appends.
    // For now it always logs "not implemented" and returns, so we report
    // false here — the truth is "no append happened."
    appendedToSent = false;
  } catch (err) {
    // Non-fatal: the email already sent. Log and continue.
    const e = err as Error;
    console.warn(`[smtp] appendSent failed (email already sent, continuing): ${e.message}`);
    appendedToSent = false;
  }

  return {
    messageId: typeof info.messageId === 'string' ? info.messageId : undefined,
    appendedToSent,
  };
}