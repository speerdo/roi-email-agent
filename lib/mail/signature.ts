// lib/mail/signature.ts
//
// Branded email signature appended to every outbound reply by lib/smtp.ts.
// Kept separate from the SMTP transport so editing the signature is a
// one-file diff and so scripts/test-smtp.ts can reuse it for previews.
//
// The logo image is embedded as an INLINE attachment (cid:signature-logo)
// rather than referenced by a remote URL — modern email clients (Gmail,
// Outlook, Apple Mail) block remote images by default until the user
// clicks "show images", but inline cid: attachments render immediately.
//
// Path is resolved relative to the project root so it works both under
// `vercel dev` (cwd = repo root) and in the Vercel build output.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
// lib/mail/ -> ../../assets/images/signature-logo.png
const LOGO_PATH = resolve(__dirname, '../../assets/images/signature-logo.png');

export interface SignatureAttachment {
  filename: string;
  cid: string;
  contentType: string;
  content: Buffer;
  encoding: string;
}

let cachedLogo: Buffer | null = null;

function logoBuffer(): Buffer {
  if (cachedLogo) return cachedLogo;
  cachedLogo = readFileSync(LOGO_PATH);
  return cachedLogo;
}

/**
 * The "RecycleOldTech / Adam" sign-off Gemini and the recycling templates
 * append to every draft. Once the branded signature block is appended at
 * SMTP time, the sign-off is redundant (Adam Speer appears in the real
 * signature below it), so it is stripped before sending — see
 * stripDraftSignoff().
 */
export const DRAFT_SIGNOFF = 'RecycleOldTech / Adam';

/**
 * Remove the house sign-off ("RecycleOldTech / Adam") from the end of a
 * draft. The branded signature block appended at SMTP time already
 * includes Adam's name, so keeping the sign-off would render it twice in
 * a row:
 *
 *   We appreciate you thinking of us.
 *   RecycleOldTech / Adam        <- duplicated, looks broken
 *   --
 *   Adam Speer
 *   RecycleOldTech
 *   https://recycleoldtech.com
 *
 * Tolerates trailing whitespace/newlines and optional surrounding blank
 * lines. Nothing else in the body is touched — the sign-off is only ever
 * the last non-empty line, and the pattern is exact so a mid-body "made
 * by RecycleOldTech / Adam & sons" would never match.
 */
export function stripDraftSignoff(draft: string): string {
  return draft
    .replace(/[ \t]+$/gm, '')
    .replace(new RegExp(`(?:\\n*${DRAFT_SIGNOFF}[ \\t]*\\n*)+$`), '')
    .trimEnd();
}

/**
 * Plain-text signature block. Appended after the draft body with a
 * blank separator line. Kept short and ASCII-only so it reads cleanly
 * in plain-text clients and in the Discord card preview (which shows
 * the text part).
 */
export const TEXT_SIGNATURE = [
  '',
  '--',
  'Adam Speer',
  'RecycleOldTech',
  'https://recycleoldtech.com',
].join('\n');

/**
 * Convert a plain-text draft into a paragraph-based HTML block. Drafts
 * arrive with \n\n paragraph breaks (from Gemini and the recyclingHelp
 * templates) and occasional single \n soft breaks.
 *
 * We deliberately do NOT wrap the draft in a single <pre> relying on
 * `white-space:pre-wrap`: the sanitizers in some webmail clients
 * (notably Open-Xchange builds such as PrivateEmail) strip that
 * property, and the client then renders every line run together into
 * one wall of text. Real paragraph tags survive sanitization everywhere.
 */
const FONT_STYLE = 'font-family:Arial, Helvetica, sans-serif; font-size:14px; line-height:1.5; color:#111827;';

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Turn draft text into sanitized HTML paragraphs: split on \n\n (or more
 * newlines) into paragraphs; within a paragraph, single \n soft breaks
 * become <br>. Each paragraph is HTML-escaped so model output can't
 * inject markup, and wrapped in a <p> with the house font styling.
 */
export function draftToHtml(draftText: string): string {
  const paragraphs = draftText
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => `<p style="margin:0 0 14px 0;">${escapeHtml(p).replace(/\n/g, '<br />')}</p>`);
  return paragraphs.join('\n');
}

/**
 * HTML signature block. Inline CSS keeps it self-contained — many email
 * clients strip <style> blocks.
 */
function signatureHtml(): string {
  return `
<div style="margin-top:24px; border-top:1px solid #e5e7eb; padding-top:16px; ${FONT_STYLE}">
  <div style="font-weight:bold; font-size:15px;">Adam Speer</div>
  <div style="color:#4b5563;">RecycleOldTech</div>
  <div style="margin-top:4px;">
    <a href="https://recycleoldtech.com" style="color:#4f46e5; text-decoration:none;">www.recycleoldtech.com</a>
  </div>
  <img src="cid:signature-logo" width="300" height="37" alt="RecycleOldTech.com" style="display:block; margin-top:12px; max-width:300px; height:auto; border:0;" />
</div>`;
}

/**
 * Build the full HTML body for an outbound reply: the draft converted to
 * real <p> paragraphs (survives client sanitization, unlike <pre> +
 * white-space:pre-wrap which some webmail clients strip, collapsing the
 * message into one line) followed by the branded signature.
 */
export function buildHtmlBody(draftText: string): string {
  return `<div style="${FONT_STYLE}">
${draftToHtml(draftText)}${signatureHtml()}
</div>`;
}

/**
 * Nodemailer attachment descriptor for the inline logo. Attach this to
 * the sendMail call so `cid:signature-logo` in the HTML resolves to
 * the embedded image bytes.
 */
export function signatureAttachment(): SignatureAttachment {
  return {
    filename: 'recycleoldtech-logo.png',
    cid: 'signature-logo',
    contentType: 'image/png',
    content: logoBuffer(),
    encoding: 'base64',
  };
}