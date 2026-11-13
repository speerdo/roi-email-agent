import { randomUUID } from 'node:crypto';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { Transporter } from 'nodemailer';
import { getEnv } from './env.js';
import { appendSent } from './imap.js';
import { replyInReplyTo, replyReferences, replySubject } from './mail/headers.js';
import type { BrandProfile } from './brands/index.js';
import { requireBrandEnv } from './brands/env.js';
import {
  buildHtmlBody,
  signatureAttachment,
  stripDraftSignoff,
  textSignature,
} from './mail/signature.js';

// ---- Public types ---------------------------------------------------------

export interface SendReplyInput {
  to: string;
  /** Subject of the INBOUND message. We add `Re: ` here (idempotently)
   *  rather than trusting callers to remember — see lib/mail/headers.ts
   *  replySubject(). */
  subject: string;
  text: string;
  /** The INBOUND message's own Message-ID (i.e. row.messageId). Used as
   *  the outbound reply's In-Reply-To anchor and appended to References.
   *  NOT the inbound's In-Reply-To (which points at the inbound's PARENT
   *  and is the wrong thread anchor for our reply) — see
   *  lib/mail/headers.ts for the threading rationale. */
  inboundMessageId?: string;
  /** The INBOUND message's References header chain (i.e.
   *  row.emailReferences). The outbound reply's References = this chain
   *  + inboundMessageId, per RFC 5322 §3.6.4. */
  inboundReferences?: string;
  /** The brand that owns the row being replied to. Drives the SMTP
   *  credentials (per-brand mailbox), the From display name and the
   *  branded signature. Required — there is no default, so a caller that
   *  forgets to load row.brand fails loudly instead of sending as the
   *  wrong brand. */
  brand: BrandProfile;
}

export interface SendReplyResult {
  messageId: string | undefined;
  /** True only when the sent message was actually appended to the brand's
   *  IMAP Sent folder. False when the append was skipped (no Sent folder)
   *  or failed; either way the email itself HAS been sent. */
  appendedToSent: boolean;
}

// ---- Transport lifecycle --------------------------------------------------

/**
 * Created fresh on every call (no shared pool) — serverless-friendly, since
 * a pooled connection cached at module scope can go stale across cold starts.
 */
function getTransport(brand: BrandProfile): Transporter {
  const env = getEnv();
  const brandEnv = requireBrandEnv(brand);
  return nodemailer.createTransport({
    host: env.EMAIL_SMTP_HOST,
    port: env.EMAIL_SMTP_PORT,
    secure: true, // port 465 is implicit TLS
    auth: { user: brandEnv.emailUser, pass: brandEnv.emailPass },
  });
}

// ---- Public API -----------------------------------------------------------

/**
 * Send a reply via the brand's SMTP mailbox, threaded to the inbound
 * message via In-Reply-To + References headers. The display name is the
 * brand's fromName and the from address is that brand's mailbox user.
 * Host/port, threading and signature handling are shared.
 *
 * Threading headers (SPEC §3.3): the reply's In-Reply-To is the INBOUND
 * message's Message-ID (NOT the inbound's In-Reply-To, which points at
 * its parent). References = the inbound's References + inbound Message-ID.
 * Subject is prefixed with `Re: ` idempotently. All three are derived
 * here from the row-shaped input rather than trusting callers, so a
 * future caller can't accidentally pass the wrong header.
 *
 * The raw MIME is built once (MailComposer, with an explicit Message-ID),
 * sent as-is via the transport, and the SAME bytes are then appended to
 * the brand's IMAP Sent folder with `\\Seen`, so the sent copy and the
 * saved copy are byte-identical. The append is non-fatal — the email was
 * already sent, so any failure (or a mailbox with no Sent folder) is
 * logged and reported as `appendedToSent: false`, never thrown.
 */
export async function sendReply(input: SendReplyInput): Promise<SendReplyResult> {
  const brand = input.brand;
  const brandEnv = requireBrandEnv(brand);
  const transport = getTransport(brand);

  const from = `"${brand.fromName}" <${brandEnv.emailUser}>`;

  // Derive threading headers from the inbound row. These MUST come from
  // row.messageId (the inbound's own ID) and row.emailReferences (the
  // inbound's References chain) — NOT from row.inReplyTo, which is the
  // inbound's PARENT and the wrong thread anchor. See lib/mail/headers.ts.
  const subject = replySubject(input.subject);
  const inReplyTo = replyInReplyTo(input.inboundMessageId);
  const references = replyReferences(input.inboundMessageId, input.inboundReferences);

  // Plain text: draft + branded signature block.
  // HTML: draft (real <p> paragraphs) + branded signature with the
  // inline-embedded logo via cid:signature-logo. Email clients that
  // block remote images by default still render inline cid: attachments.
  //
  // The sign-off is stripped before both builds: the signature block
  // below it already carries Adam's name, so leaving it in would show it
  // twice in a row. Drafts are normally stripped when they are STORED
  // (lib/poll/runner.ts and the Discord edit modal) so the card and the
  // email agree; this call is the defensive second pass that also covers
  // rows written before that and is a no-op on an already-clean body.
  const body = stripDraftSignoff(input.text);
  const text = `${body}\n${textSignature(brand)}`;
  const html = buildHtmlBody(body, brand);
  const attachments = [signatureAttachment(brand)];

  // Explicit Message-ID so the SMTP copy and the Sent copy share it. The
  // domain is the sending mailbox's, so it looks like any other message
  // from that mailbox.
  const domain = brandEnv.emailUser.split('@')[1] ?? 'localhost';
  const messageId = `<${randomUUID()}@${domain}>`;

  // Build the raw MIME ONCE; these exact bytes go out over SMTP and into
  // the Sent folder.
  const raw = await new MailComposer({
    from,
    to: input.to,
    subject,
    text,
    html,
    attachments,
    messageId,
    // nodemailer types reject null; only pass the headers when non-null.
    ...(inReplyTo ? { inReplyTo } : {}),
    ...(references ? { references } : {}),
  })
    .compile()
    .build();

  // With `raw`, nodemailer does not derive the SMTP envelope from the
  // headers, so it is passed explicitly (bare addresses, not display form).
  await transport.sendMail({
    envelope: { from: brandEnv.emailUser, to: [input.to] },
    raw,
  });

  // Best-effort mirror to the brand's IMAP Sent folder (its own
  // credentials). Never throws past here: the email is already out.
  let appendedToSent = false;
  try {
    appendedToSent = await appendSent(raw, {
      user: brandEnv.emailUser,
      pass: brandEnv.emailPass,
    });
  } catch (err) {
    const e = err as Error;
    console.warn(`[smtp] appendSent failed (email already sent, continuing): ${e.message}`);
  }

  return { messageId, appendedToSent };
}
