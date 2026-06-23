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
// lib/mail/ -> ../../assets/images/default-og.png
const LOGO_PATH = resolve(__dirname, '../../assets/images/default-og.png');

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
 * HTML signature block. The {BODY} placeholder is replaced with the
 * HTML-escaped draft body (wrapped in <pre> to preserve Gemini's
 * newlines) by buildSignatureHtml() below.
 *
 * Inline CSS keeps it self-contained — many email clients strip
 * <style> blocks. The logo sits to the left of the text in a
 * two-column table (the most reliable layout construct in email HTML).
 */
function signatureHtml(): string {
  return `
<div style="margin-top:24px; border-top:1px solid #e5e7eb; padding-top:16px; font-family:Arial, Helvetica, sans-serif; font-size:14px; line-height:1.5; color:#111827;">
  <div style="font-weight:bold; font-size:15px;">Adam Speer</div>
  <div style="color:#4b5563;">RecycleOldTech</div>
  <div style="margin-top:4px;">
    <a href="https://recycleoldtech.com" style="color:#4f46e5; text-decoration:none;">www.recycleoldtech.com</a>
  </div>
  <img src="cid:signature-logo" width="300" height="158" alt="RecycleOldTech" style="display:block; margin-top:12px; max-width:100%; height:auto; border-radius:8px;" />
</div>`;
}

/**
 * Build the full HTML body for an outbound reply: the draft text in a
 * <pre> block (preserves newlines without forcing a monospace font on
 * the whole message) followed by the branded signature. Draft text is
 * HTML-escaped so model output can't inject markup.
 */
export function buildHtmlBody(draftText: string): string {
  const escaped = draftText
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<div style="font-family:Arial, Helvetica, sans-serif; font-size:14px; line-height:1.5; color:#111827;">
<pre style="font-family:Arial, Helvetica, sans-serif; white-space:pre-wrap; margin:0;">${escaped}</pre>${signatureHtml()}
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