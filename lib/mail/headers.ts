// lib/mail/headers.ts
//
// Threading header helpers for outbound replies.
//
// The bug this fixes (SPEC §3.3): api/discord.ts used to pass
// `inReplyTo: row.inReplyTo`, where `row.inReplyTo` is the INBOUND
// message's own In-Reply-To header — i.e. its PARENT. For a fresh
// inbound email that header is absent, so our reply carried no
// In-Reply-To at all and email clients threaded it as a brand-new
// conversation. The reply's In-Reply-To must instead be the INBOUND
// message's Message-ID (i.e. `row.messageId`), with References =
// the inbound's References chain + its Message-ID.
//
// Also normalizes the angle brackets mailparser may or may not include
// around a Message-ID, and adds a `Re:` prefix to the subject when one
// isn't already present (idempotent on already-`Re:` subjects).

/**
 * Prefix the runner synthesizes for messages that arrived with no
 * Message-ID header (`no-message-id:<uid>`), so the `message_id` unique
 * constraint still dedupes them. It is an internal database key, NOT a
 * real Message-ID: emitting it in In-Reply-To/References would put a
 * fabricated identifier on the wire that no client can resolve. Treat it
 * as "no Message-ID" here. Kept in sync with lib/poll/runner.ts.
 */
const SYNTHETIC_ID_PREFIX = 'no-message-id:';

/** Whether a stored message_id is a real header value we can thread on. */
function isRealMessageId(id: string): boolean {
  return id.length > 0 && !id.startsWith(SYNTHETIC_ID_PREFIX);
}

/**
 * Wrap a Message-ID in angle brackets if it doesn't already have them.
 * mailparser sometimes strips them; SMTP requires them on In-Reply-To
 * and References per RFC 5322 §3.6.4.
 */
export function bracketMessageId(messageId: string): string {
  const trimmed = messageId.trim();
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) return trimmed;
  return `<${trimmed}>`;
}

/**
 * Build the In-Reply-To header value for an outbound reply. MUST be the
 * inbound message's own Message-ID (not the inbound's In-Reply-To, which
 * points at its parent and is the wrong thread anchor for our reply).
 *
 * Returns null when the inbound had no Message-ID — there's nothing to
 * thread against, and we'd rather send no header than a malformed one.
 */
export function replyInReplyTo(inboundMessageId: string | null | undefined): string | null {
  if (!inboundMessageId) return null;
  const trimmed = inboundMessageId.trim();
  if (!isRealMessageId(trimmed)) return null;
  return bracketMessageId(trimmed);
}

/**
 * Build the References header value for an outbound reply. Per RFC 5322
 * §3.6.4, References is the inbound's References chain followed by the
 * inbound's own Message-ID — i.e. the full ancestor chain ending at the
 * message we're replying to. Space-separated, each bracketed.
 *
 * Returns null when the inbound had no Message-ID AND no References.
 */
export function replyReferences(
  inboundMessageId: string | null | undefined,
  inboundReferences: string | null | undefined,
): string | null {
  const refsRaw = (typeof inboundReferences === 'string' ? inboundReferences.trim() : '');
  const msgId = (typeof inboundMessageId === 'string' ? inboundMessageId.trim() : '');

  const parts: string[] = [];
  if (refsRaw) {
    // The inbound's References may already be a space-separated list of
    // bracketed IDs; split, trim, and re-bracket defensively so a stray
    // unbracketed ID doesn't corrupt the chain.
    for (const r of refsRaw.split(/\s+/)) {
      const t = r.trim();
      if (t) parts.push(bracketMessageId(t));
    }
  }
  if (isRealMessageId(msgId)) {
    const bracketed = bracketMessageId(msgId);
    // Avoid duplicate if the inbound's References already ended with its
    // own Message-ID (some clients do this).
    if (!parts.includes(bracketed)) parts.push(bracketed);
  }

  if (parts.length === 0) return null;
  return parts.join(' ');
}

/**
 * Prefix a subject with `Re: ` for an outbound reply, idempotently.
 * If the subject already starts with `Re:` (case-insensitive, with or
 * without the trailing colon/space), it's returned unchanged so we don't
 * accumulate `Re: Re: Re:` chains. Empty/undefined subjects fall back
 * to `(no subject)`.
 */
export function replySubject(subject: string | null | undefined): string {
  const s = (typeof subject === 'string' ? subject.trim() : '') || '(no subject)';
  return /^re:/i.test(s) ? s : `Re: ${s}`;
}