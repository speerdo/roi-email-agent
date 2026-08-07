// lib/mail/recipient.ts
//
// Resolve which address an outbound reply must actually go to.
//
// The naive rule "reply to From" is wrong for any sender that wraps a real
// human behind a notification address. The canonical case in this codebase
// is Web3Forms: every form submission arrives as
//
//   From:     "Notifications" <notify@web3forms.com>
//   Reply-To: <the actual submitter>
//
// Without consulting Reply-To, every approved reply to a form submission
// gets mailed back to notify@web3forms.com and the human never sees it.
// This is exactly what was happening before this module existed — see
// docs/SPEC_TRIAGE_FIXES.md §2.2.
//
// The other failure mode this module guards against: a self-addressed
// message (hello@recycleoldtech.com appearing as From/Reply-To, e.g. an
// SMTP test or a self-CC) plus an Approve tap would otherwise mail
// ourselves. We refuse instead and let the caller surface a clear error
// on the Discord card.
//
// noreply@ / MAILER-DAEMON@ addresses are also refused: replying to them
// is at best a wasted send and at worst generates another bounce that
// lands in the same inbox (see §3.6 for bounce handling).
//
// NOTE: we read EMAIL_USER directly from process.env rather than getEnv()
// so this pure matcher stays decoupled from the full app env (EMAIL_PASS,
// DATABASE_URL, ...) — same pattern as lib/mail/prefilter.ts.

export interface RecipientInput {
  /** Reply-To header value from the inbound message, or null/undefined
   *  when absent. The DB column is nullable; pass it through verbatim. */
  replyTo: string | null | undefined;
  /** From address of the inbound message. Always present (DB NOT NULL). */
  fromAddr: string;
}

export interface ResolvedRecipient {
  /** The address the SMTP `to` field must use. */
  to: string;
  /** Which header we resolved it from — surfaced on the Discord card so a
   *  reviewer can spot a mis-resolved reply BEFORE approving. */
  source: 'reply-to' | 'from';
}

/** Addresses we refuse to mail back to. Lowercased match against the
 *  local-part start, so `noreply@anything` and `mailer-daemon@anything`
 *  both match. `hello@recycleoldtech.com` is matched exactly (our own
 *  mailbox — see process.env.EMAIL_USER). */
const NO_REPLY_LOCAL_PREFIXES = ['noreply', 'no-reply', 'mailer-daemon', 'postmaster'] as const;

function isNoReplyAddress(addr: string): boolean {
  const local = addr.split('@')[0]?.toLowerCase() ?? '';
  if (!local) return false;
  return NO_REPLY_LOCAL_PREFIXES.some((p) => local === p || local.startsWith(p));
}

function ownMailbox(): string {
  return (process.env.EMAIL_USER ?? '').toLowerCase();
}

/**
 * Resolve the address an outbound reply must go to, or null when neither
 * From nor Reply-To is a valid reply target (both are noreply / DSN / our
 * own mailbox). Callers MUST refuse to send when this returns null and
 * surface a clear card message instead of silently skipping.
 *
 * Resolution order:
 *   1. Reply-To, if present AND not a no-reply-style address AND not our
 *      own mailbox. (Reply-To wins over From per RFC 5322 §3.6.2.)
 *   2. Otherwise From, subject to the same filters.
 *   3. Otherwise null — no safe reply target exists.
 */
export function replyRecipient(input: RecipientInput): ResolvedRecipient | null {
  const me = ownMailbox();

  const replyTo = typeof input.replyTo === 'string' ? input.replyTo.trim() : '';
  const fromAddr = typeof input.fromAddr === 'string' ? input.fromAddr.trim() : '';

  if (replyTo) {
    const lt = replyTo.toLowerCase();
    if (me && lt === me) {
      // Don't mail ourselves, even if Reply-To explicitly says so.
    } else if (isNoReplyAddress(replyTo)) {
      // Reply-To was set to a noreply address — fall through to From rather
      // than sending into the void. (Some senders set Reply-To=noreply@ to
      // discourage replies; From may still be reachable.)
    } else {
      return { to: replyTo, source: 'reply-to' };
    }
  }

  if (fromAddr) {
    const lf = fromAddr.toLowerCase();
    if (me && lf === me) return null;
    if (isNoReplyAddress(fromAddr)) return null;
    return { to: fromAddr, source: 'from' };
  }

  return null;
}

/**
 * Display form for the Discord card's "Reply to" field. Shows the real
 * recipient (what a reply will actually be addressed to) and, when it
 * differs from the inbound From, annotates the original sender in
 * parentheses so a reviewer can see the rerouting at a glance.
 *
 *   replyRecipient({replyTo:'fcrman@aol.com', fromAddr:'notify@web3forms.com'})
 *     -> "fcrman@aol.com (via notify@web3forms.com)"
 *
 *   replyRecipient({replyTo:null, fromAddr:'jane@example.com'})
 *     -> "jane@example.com"
 *
 * Returns null when replyRecipient() itself returns null (no safe target);
 * callers should render a "no reply target" marker instead of mailing.
 */
export function recipientDisplay(input: RecipientInput, fromName?: string | null): string | null {
  const resolved = replyRecipient(input);
  if (!resolved) return null;
  if (resolved.source === 'reply-to' && input.fromAddr && resolved.to !== input.fromAddr) {
    return `${resolved.to} (via ${input.fromAddr})`;
  }
  // Reply goes to From, so the From display name genuinely belongs to the
  // recipient — keep it for readability ("Jane Doe <jane@example.com>").
  // Deliberately NOT applied on the reply-to branch: there the display name
  // belongs to the notification bot, not the human we're writing to.
  const name = (fromName ?? '').trim();
  return name ? `${name} <${resolved.to}>` : resolved.to;
}