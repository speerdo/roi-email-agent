// lib/mail/newsletter.ts
//
// Parse a newsletter-signup notification into (email, sourcePage) for the
// newsletter_subscribers upsert. Format per docs/brands/DOWNTOWNDRY_PROFILE.md
// §3.1: Web3Forms posts with subject `New Newsletter Subscriber - <Page>`
// and the subscriber address on an `email : <address>` line in the body.

/** Subject prefix all DD newsletter signups carry. */
export const NEWSLETTER_SUBJECT_PREFIX = 'new newsletter subscriber';

/**
 * Extract the page name from the subject suffix. Accepts both
 * "New Newsletter Subscriber - Blog Page" and "(Blog Page)" separators.
 * Returns null when there is no suffix.
 */
export function parseNewsletterPage(subject: string): string | null {
  const s = subject.trim();
  const lower = s.toLowerCase();
  const idx = lower.indexOf(NEWSLETTER_SUBJECT_PREFIX);
  if (idx === -1) return null;
  let rest = s.slice(idx + NEWSLETTER_SUBJECT_PREFIX.length).trim();
  // Strip common separators: "- Page", "– Page", ": Page", "(Page)".
  rest = rest.replace(/^[\s\-–—:()]+/, '').replace(/[)\s]+$/, '').trim();
  return rest.length > 0 ? rest : null;
}

/**
 * Extract the subscriber address from an `email : <address>` body line.
 * Case-insensitive on the label, tolerant of extra whitespace and of the
 * "name :" / "email :" Web3Forms body shape. Returns the lowercased
 * address, or null when the body carries none.
 */
export function parseNewsletterEmail(body: string): string | null {
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    const m = line.match(/^email\s*:\s*(.+)$/i);
    if (m && m[1] !== undefined) {
      const email = m[1].trim().toLowerCase();
      // Minimal sanity check: something@something.
      if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return email;
      return null;
    }
  }
  return null;
}

export interface NewsletterSignup {
  email: string;
  sourcePage: string | null;
}

/** Both fields in one call; null when the body has no usable address. */
export function parseNewsletterSignup(body: string, subject: string): NewsletterSignup | null {
  const email = parseNewsletterEmail(body);
  if (!email) return null;
  return { email, sourcePage: parseNewsletterPage(subject) };
}
