import { getCommaList, getBool } from '../env.js';
import type { ParsedFrom } from './clean.js';

// ---- Types ----------------------------------------------------------------

export type PrefilterCategory = 'recycling_request' | 'newsletter' | 'dmarc' | 'bounce';

export interface PrefilterMatch {
  matched: true;
  category: PrefilterCategory;
  skipReason: string;
  markRead: boolean;
}

export interface PrefilterNoMatch {
  matched: false;
}

export type PrefilterResult = PrefilterMatch | PrefilterNoMatch;

// ---- Config (read once, cached) -----------------------------------------

interface FilterConfig {
  automatedFormSubjects: string[];
  automatedFormFrom: string;        // single substring, lowercased
  automatedFormMarkRead: boolean;
  newsletterFrom: string;           // single substring, lowercased
  newsletterSubjects: string[];      // optional, lowercased
  newsletterMarkRead: boolean;
  dmarcSubjects: string[];          // lowercased
  dmarcFrom: string;                 // optional substring, lowercased
  dmarcMarkRead: boolean;
}

let configCache: FilterConfig | null = null;

// NOTE on caching: configCache is process-lifetime. On Vercel Fluid
// Compute a warm instance keeps stale pre-filter env after an env var
// change until the instance recycles. Acceptable for the pre-filter
// (config changes are rare and a stale match/no-match is at worst a
// misrouted single message), but worth knowing when debugging a "why
// didn't the new NEWSLETTER_FROM take effect" report. resetPrefilterConfig()
// is the test-only escape hatch.
function loadConfig(): FilterConfig {
  if (configCache) return configCache;
  // NOTE: we read pre-filter env vars directly via process.env rather than
  // getEnv() — pre-filters only need their own config subset, and forcing
  // the full app env (EMAIL_PASS, DATABASE_URL, ...) just to match a
  // subject would couple this pure matcher to credentials it doesn't use.
  configCache = {
    automatedFormSubjects: getCommaList('AUTOMATED_FORM_SUBJECTS').map((s) => s.toLowerCase()),
    automatedFormFrom: (process.env.AUTOMATED_FORM_FROM ?? '').toLowerCase(),
    automatedFormMarkRead: getBool('AUTOMATED_FORM_MARK_READ', true),
    newsletterFrom: (process.env.NEWSLETTER_FROM ?? '').toLowerCase(),
    newsletterSubjects: getCommaList('NEWSLETTER_SUBJECTS').map((s) => s.toLowerCase()),
    newsletterMarkRead: getBool('NEWSLETTER_MARK_READ', true),
    dmarcSubjects: getCommaList('DMARC_SUBJECTS').map((s) => s.toLowerCase()),
    dmarcFrom: (process.env.DMARC_FROM ?? '').toLowerCase(),
    dmarcMarkRead: getBool('DMARC_MARK_READ', true),
  };
  return configCache;
}

/** Reset cached config — for tests that mutate process.env. */
export function resetPrefilterConfig(): void {
  configCache = null;
}

// ---- Matchers ------------------------------------------------------------

/**
 * Recycling request: BOTH a subject prefix match (case-insensitive
 * startsWith on any AUTOMATED_FORM_SUBJECTS entry) AND an AUTOMATED_FORM_FROM
 * substring match in the sender address. Both required — see plan §7a
 * shared-inbox caution.
 */
export function matchRecyclingRequest(subject: string, fromAddress: string): boolean {
  const cfg = loadConfig();
  const subj = subject.toLowerCase();
  const from = fromAddress.toLowerCase();
  if (!cfg.automatedFormFrom || !from.includes(cfg.automatedFormFrom)) return false;
  return cfg.automatedFormSubjects.some((prefix) => subj.startsWith(prefix));
}

/**
 * Newsletter: sender contains NEWSLETTER_FROM OR subject matches a
 * NEWSLETTER_SUBJECTS entry (when any are set).
 */
export function matchNewsletter(subject: string, fromAddress: string): boolean {
  const cfg = loadConfig();
  const subj = subject.toLowerCase();
  const from = fromAddress.toLowerCase();
  if (cfg.newsletterFrom && from.includes(cfg.newsletterFrom)) return true;
  if (cfg.newsletterSubjects.length > 0) {
    return cfg.newsletterSubjects.some((s) => subj.includes(s));
  }
  return false;
}

/**
 * DMARC report: subject contains any DMARC_SUBJECTS entry; AND sender
 * contains DMARC_FROM when set (when unset, subject match alone suffices).
 */
export function matchDmarc(subject: string, fromAddress: string): boolean {
  const cfg = loadConfig();
  const subj = subject.toLowerCase();
  const from = fromAddress.toLowerCase();
  const subjectHit = cfg.dmarcSubjects.some((s) => subj.includes(s));
  if (!subjectHit) return false;
  if (cfg.dmarcFrom && !from.includes(cfg.dmarcFrom)) return false;
  return true;
}

/**
 * Bounce / delivery-status notification (RFC 3464). Either the From
 * address starts with MAILER-DAEMON@ (the conventional DSN sender) OR
 * the Content-Type is multipart/report with report-type=delivery-status.
 * Both signals are deterministic — no LLM call needed. Bounces are
 * marked read + skipped, and surfaced via a weekly digest so address
 * typos in the recycling form (e.g. ".ccom") and any deliverability
 * problem with our own domain don't sit invisible forever.
 */
export function matchBounce(fromAddress: string, contentType?: string): boolean {
  const from = fromAddress.toLowerCase();
  if (from.startsWith('mailer-daemon@') || from.startsWith('postmaster@')) return true;
  if (contentType) {
    const ct = contentType.toLowerCase();
    if (ct.includes('multipart/report') && ct.includes('report-type=delivery-status')) return true;
  }
  return false;
}

// ---- Driver ---------------------------------------------------------------

export interface PrefilterInput {
  subject: string;
  from: ParsedFrom | { address: string };
  /** Content-Type header of the inbound message, when available. Used by
   *  the bounce pre-filter to detect multipart/report delivery-status
   *  notifications (RFC 3464) that don't always carry a recognizable
   *  From address. Optional — older callers omit it and the bounce
   *  filter falls back to the MAILER-DAEMON From check alone. */
  contentType?: string;
}

/**
 * Run all pre-filters in plan order: recycling, newsletter, dmarc, bounce.
 * Only the FIRST match wins; everything else falls through to the LLM.
 */
export function runPrefilters(msg: PrefilterInput): PrefilterResult {
  const subject = msg.subject ?? '';
  const fromAddress = msg.from.address ?? '';
  const cfg = loadConfig();

  if (matchRecyclingRequest(subject, fromAddress)) {
    return {
      matched: true,
      category: 'recycling_request',
      skipReason: 'recycling_form_make_handled',
      markRead: cfg.automatedFormMarkRead,
    };
  }

  if (matchNewsletter(subject, fromAddress)) {
    return {
      matched: true,
      category: 'newsletter',
      skipReason: 'newsletter',
      markRead: cfg.newsletterMarkRead,
    };
  }

  if (matchDmarc(subject, fromAddress)) {
    return {
      matched: true,
      category: 'dmarc',
      skipReason: 'dmarc_report',
      markRead: cfg.dmarcMarkRead,
    };
  }

  if (matchBounce(fromAddress, msg.contentType)) {
    return {
      matched: true,
      category: 'bounce',
      skipReason: 'bounce',
      // Always mark bounces read — they're never reply-worthy and leaving
      // them unread pollutes the inbox badge. The weekly digest script
      // surfaces their content separately.
      markRead: true,
    };
  }

  return { matched: false };
}
