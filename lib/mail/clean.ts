// Body cleaning + sender parsing for pre-filter and LLM-input prep.

export interface ParsedFrom {
  address: string;
  name?: string;
}

// Common signature markers we strip. Conservative — we want to strip
// obvious signatures but never eat real content. The `-- ` separator is
// the RFC 3676 signature delimiter; the others are heuristics.
const SIGNATURE_MARKERS = [
  /^--\s*$/m,                          // RFC 3676 signature delimiter
  /^(?:best regards|kind regards|regards|cheers|thanks|sincerely)[,]?\s*$/im,
  /^(?:sent from my|--) /im,           // "Sent from my iPhone", "Sent from ..."
];

// Quoted-reply patterns. The `> ` prefix with the trailing newline is
// universal. The "On <date> ... wrote:" block opens a quoted section;
// everything after it is history. The block may span multiple lines when
// the email address wraps, so we allow up to ~10 lines before "wrote:".
const QUOTE_LINE = /^>.*$\n?/gm;
const QUOTE_BLOCK_OPEN =
  /^\s*On\s+[\s\S]{0,400}?wrote:\s*$/m;

/**
 * Strip signature blocks, quoted reply history, and excess whitespace
 * from a raw email body, then truncate to `maxChars` (default 2000) at a
 * word boundary so the LLM gets a compact, content-only snippet.
 */
export function cleanBody(raw: string, maxChars = 2000): string {
  let body = raw;

  // Strip everything from the first "On <date> ... wrote:" block onward.
  // This is the strongest signal we have for "the rest is quoted history".
  const wroteMatch = body.match(QUOTE_BLOCK_OPEN);
  if (wroteMatch && wroteMatch.index !== undefined) {
    body = body.slice(0, wroteMatch.index);
  }

  // Drop individual `> `-prefixed lines (some clients inline-quote).
  body = body.replace(QUOTE_LINE, '');

  // Strip signature blocks. We look for the first occurrence of any marker
  // and cut everything from that line onward.
  for (const marker of SIGNATURE_MARKERS) {
    const m = body.match(marker);
    if (m && m.index !== undefined) {
      body = body.slice(0, m.index);
    }
  }

  // Collapse whitespace runs (windows become one, trailing/leading trimmed).
  body = body.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

  // Truncate at a word boundary.
  if (body.length <= maxChars) return body;
  const slice = body.slice(0, maxChars + 1);
  const lastSpace = slice.lastIndexOf(' ');
  // If no space found in the first maxChars, just hard-cut.
  const cutAt = lastSpace > maxChars * 0.75 ? lastSpace : maxChars;
  return body.slice(0, cutAt).trimEnd() + '…';
}

/**
 * Parse a raw "From" header value into {address, name}. Accepts formats:
 *   "Name" <addr@example.com>
 *   Name <addr@example.com>
 *   addr@example.com
 *   addr@example.com (Comment)
 */
export function parseFromHeader(raw: string | undefined | null): ParsedFrom {
  if (!raw) return { address: '' };
  const trimmed = raw.trim();

  // angled form: ... <addr>
  const angled = trimmed.match(/^"?([^<"]*?)"?\s*<([^>]+)>/);
  if (angled) {
    const name = (angled[1] ?? '').trim();
    return {
      address: (angled[2] ?? '').trim(),
      name: name.length > 0 ? name : undefined,
    };
  }

  // parentheses form: addr (Comment)
  const paren = trimmed.match(/^([^\s(]+)\s*\(([^)]*)\)/);
  if (paren) {
    const name = (paren[2] ?? '').trim();
    return {
      address: (paren[1] ?? '').trim(),
      name: name.length > 0 ? name : undefined,
    };
  }

  // bare address
  return { address: trimmed };
}