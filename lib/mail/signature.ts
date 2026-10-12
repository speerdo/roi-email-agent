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
 * The canonical house sign-off. Kept exported because it names the exact
 * wording the recycling templates and older stored drafts use; the
 * stripper below matches a wider family than this one string.
 */
export const DRAFT_SIGNOFF = 'RecycleOldTech / Adam';

/**
 * Trailing lines that are a sign-off rather than body text. Matched
 * against a normalized line (trimmed, leading dash/bullet removed,
 * trailing punctuation removed, lowercased) so "- Adam", "Adam." and
 * "adam" all collapse to the same shape.
 *
 * Only ever applied to lines at the END of a draft (see
 * stripDraftSignoff), so a body sentence that happens to be short is
 * safe — the walk stops at the first line that is not a sign-off.
 */
const SIGNOFF_LINES: RegExp[] = [
  // The house sign-off, either order, any slash/dash spacing.
  /^recycleoldtech(?:\.com)?\s*[/|-]\s*adam(?: speer)?$/,
  /^adam(?: speer)?\s*[/|-]\s*recycleoldtech(?:\.com)?$/,
  // Either half alone, for the "Adam" over "RecycleOldTech" variant the
  // model produces when it ignores the exact wording.
  /^(?:the )?recycleoldtech(?:\.com)?(?: team)?$/,
  /^adam(?: speer)?$/,
  // A bare valediction with nothing after it. Must match the WHOLE line:
  // "Thanks again for reaching out!" is body text and stays.
  /^(?:thanks|thanks again|thank you|thank you again|many thanks|thanks so much|best|best regards|kind regards|warm regards|warmly|regards|cheers|sincerely|all the best|talk soon)$/,
];

/**
 * The most trailing non-blank lines we will drop. A real sign-off block
 * is at most a valediction + name + brand (3); the cap keeps a
 * pathological draft made entirely of short lines from being eaten.
 */
const MAX_SIGNOFF_LINES = 4;

function isSignoffLine(line: string): boolean {
  const normalized = line
    .trim()
    .replace(/^[-–—*]\s*/, '')
    .replace(/[.,!;:]+$/, '')
    .trim()
    .toLowerCase();
  if (normalized === '') return false;
  return SIGNOFF_LINES.some((re) => re.test(normalized));
}

/**
 * Remove the sign-off block from the end of a draft. The branded
 * signature appended at SMTP time already carries Adam's name and the
 * brand, so a sign-off left in the body renders twice in a row:
 *
 *   We appreciate you thinking of us.
 *   RecycleOldTech / Adam        <- duplicated, looks broken
 *   --
 *   Adam Speer
 *   RecycleOldTech
 *   https://recycleoldtech.com
 *
 * The model does not reliably emit the exact house wording — observed
 * drafts have ended "Adam", "Adam\nRecycleOldTech", and a dangling
 * "Best regards," with no name at all — so this walks trailing lines and
 * drops every one that is a sign-off (see SIGNOFF_LINES), stopping at the
 * first line of real body text. Nothing before that line is touched, so a
 * mid-body "RecycleOldTech / Adam was here" survives.
 *
 * Applied where the draft is STORED (lib/poll/runner.ts, the Discord edit
 * modal) so the card, the modal and the sent email all show the same
 * body, and again in lib/smtp.ts as a defensive pass for rows written
 * before that.
 */
export function stripDraftSignoff(draft: string): string {
  const lines = draft.replace(/[ \t]+$/gm, '').split('\n');
  let dropped = 0;
  while (lines.length > 0 && dropped < MAX_SIGNOFF_LINES) {
    // `?? ''` only satisfies noUncheckedIndexedAccess; length > 0 above.
    const last = lines[lines.length - 1] ?? '';
    if (last.trim() === '') {
      // Blank lines between/after sign-off lines are free — they do not
      // count against the cap and never stop the walk on their own.
      lines.pop();
      continue;
    }
    if (!isSignoffLine(last)) break;
    lines.pop();
    dropped++;
  }
  return lines.join('\n').trimEnd();
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