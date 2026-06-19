import { ImapFlow, type ImapFlowOptions, type FetchMessageObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import { getEnv } from './env.js';

// ---- Public types ---------------------------------------------------------

export interface FetchedMessage {
  uid: number;
  messageId: string | undefined;
  fromAddr: string;
  fromName: string | undefined;
  subject: string | undefined;
  text: string;
  textSnippet: string;          // raw text truncated to ~8k for downstream cleaning
  receivedAt: Date;
  inReplyTo: string | undefined;
  references: string | undefined;
}

export interface FetchSinceOpts {
  /** Cap on messages per fetch call. Helps keep serverless runs bounded. */
  limit?: number;
}

export interface FetchByDateOpts {
  /** Highest UID already processed; only UIDs greater than this are returned. */
  offsetUid?: number;
  /** Cap on messages per fetch call. */
  limit?: number;
}

// ---- Client lifecycle -----------------------------------------------------

function baseOptions(): ImapFlowOptions {
  const env = getEnv();
  return {
    host: env.EMAIL_IMAP_HOST,
    port: env.EMAIL_IMAP_PORT,
    secure: true,
    auth: { user: env.EMAIL_USER, pass: env.EMAIL_PASS },
    logger: false,
    disableAutoIdle: true,
  };
}

/**
 * Open an ImapFlow connection. Caller MUST guard with try/finally calling
 * client.logout() — or use withImap() below.
 */
export function connectImap(): ImapFlow {
  return new ImapFlow(baseOptions());
}

/**
 * Scoped helper: opens a connection, runs the callback with the client,
 * always closes the connection in finally.
 */
export async function withImap<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = connectImap();
  try {
    await client.connect();
    return await fn(client);
  } finally {
    try {
      await client.logout();
    } catch {
      client.close();
    }
  }
}

// ---- Fetch helpers --------------------------------------------------------

// Fetch query for peek-style fetches: source + envelope + flags + internalDate.
// imapflow's `fetch()` with `source: true` uses BODY.PEEK under the hood,
// which does NOT set \Seen regardless of the message's prior state. This
// is a library guarantee, not something we re-assert at runtime — the
// prior \Seen state of a fetched message is informational only.
const FETCH_QUERY = {
  uid: true,
  internalDate: true,
  flags: true,
  envelope: true,
  source: true,
} as const;

/**
 * Parse an imapflow FetchMessageObject (with `source` buffer) into our
 * FetchedMessage shape using mailparser for accurate body extraction.
 */
async function parseFetched(raw: FetchMessageObject): Promise<FetchedMessage> {
  const source = raw.source;
  if (!source) throw new Error(`message uid=${raw.uid} missing source buffer`);
  const parsed = await simpleParser(source);

  const fromValue = parsed.from?.value?.[0];
  const fromAddr = fromValue?.address ?? '';
  const fromName = fromValue?.name;
  const text = parsed.text ?? '';
  const receivedAt =
    parsed.date ??
    (raw.internalDate instanceof Date ? raw.internalDate : new Date());

  // references may be a single string or an array; normalize to a string.
  const referencesRaw = parsed.references;
  const references = Array.isArray(referencesRaw)
    ? referencesRaw.join(' ')
    : referencesRaw ?? undefined;

  return {
    uid: raw.uid,
    messageId: parsed.messageId ?? undefined,
    fromAddr,
    fromName,
    subject: parsed.subject ?? undefined,
    text,
    textSnippet: text.slice(0, 8000),
    receivedAt,
    inReplyTo: parsed.inReplyTo ?? undefined,
    references,
  };
}

/**
 * Incremental fetch: messages with UID > lastUid, oldest first. Peek
 * semantics (does NOT set \Seen). Yields parsed messages.
 *
 * Implementation note: when `opts.limit` is set, we first run a cheap
 * UID-only SEARCH over `lastUid+1:*` to find which UIDs actually exist,
 * then FETCH only the first `limit` of those. Narrowing the FETCH range
 * itself to `lastUid+1:lastUid+limit` would silently miss messages
 * whenever UIDs aren't contiguous (e.g. after a manual delete in
 * webmail), since that range could contain fewer than `limit` real
 * messages even though more are waiting just past it.
 *
 * Defensive filter: per RFC 3501, a range like `n:*` where `n` exceeds
 * every existing UID is normalized by swapping the bounds, so the server
 * can hand back the single highest-UID message even though it's <=
 * lastUid. We explicitly drop anything that isn't actually new so a
 * quiet mailbox never re-yields the last message it already processed.
 */
export async function* fetchSinceUid(
  client: ImapFlow,
  mailbox: string,
  lastUid: number,
  opts: FetchSinceOpts = {},
): AsyncIterableIterator<FetchedMessage> {
  const lock = await client.getMailboxLock(mailbox, { readOnly: true });
  try {
    let range = `${lastUid + 1}:*`;
    if (opts.limit) {
      const uids = await client.search({ uid: range }, { uid: true });
      const candidates = (Array.isArray(uids) ? uids : []).filter((u) => u > lastUid);
      if (candidates.length === 0) return;
      const sorted = candidates.sort((a, b) => a - b).slice(0, opts.limit);
      range = sorted.join(',');
    }
    for await (const raw of client.fetch(range, FETCH_QUERY, { uid: true })) {
      if (raw.uid <= lastUid) continue;
      yield await parseFetched(raw);
    }
  } finally {
    lock.release();
  }
}

/**
 * Backlog fetch: messages received since `since` (inclusive), ordered by
 * UID ascending. Supports `offsetUid` for resumable batching — pass the
 * highest UID already processed from a prior call to pick up with the
 * next-oldest unprocessed message; only messages with UID > offsetUid are
 * returned. Peek semantics still apply.
 *
 * Note: messages encountered here MAY be already read (the whole point of
 * using date-range rather than UNSEEN — see plan §10), so we do NOT
 * apply assertPeek. Reading via source-fetch is still peek-style (no
 * \Seen set if it wasn't already there), but finding \Seen already
 * present is expected and not an invariant violation.
 */
export async function* fetchByDateRange(
  client: ImapFlow,
  mailbox: string,
  since: Date,
  opts: FetchByDateOpts = {},
): AsyncIterableIterator<FetchedMessage> {
  const lock = await client.getMailboxLock(mailbox, { readOnly: true });
  try {
    const uids = await client.search({ since }, { uid: true });
    if (!Array.isArray(uids) || uids.length === 0) return;

    let filtered = uids as number[];
    if (opts.offsetUid !== undefined) {
      const lower = opts.offsetUid;
      filtered = filtered.filter((u) => u > lower);
    }
    filtered.sort((a, b) => a - b);

    let count = 0;
    const BATCH = 50;
    for (let i = 0; i < filtered.length; i += BATCH) {
      const batch = filtered.slice(i, i + BATCH);
      const range = batch.join(',');
      for await (const raw of client.fetch(range, FETCH_QUERY, { uid: true })) {
        if (opts.limit && count >= opts.limit) return;
        count++;
        yield await parseFetched(raw);
      }
    }
  } finally {
    lock.release();
  }
}

/**
 * Explicitly set the \\Seen flag on a message. This is the ONLY operation
 * in this module that marks a message read. Per the plan, classification
 * never sets \\Seen — only deterministic pre-filter matches (when their
 * *_MARK_READ config is true) and Approve/Reject in Discord do.
 */
export async function markSeen(client: ImapFlow, mailbox: string, uid: number): Promise<void> {
  const lock = await client.getMailboxLock(mailbox, { readOnly: false });
  try {
    await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
  } finally {
    lock.release();
  }
}

/**
 * Append a sent message to the IMAP Sent folder. Phase 9 implementation;
 * for now logs and returns so Phase 4's SMTP path can call it without
 * branching. Confirmed in preflight: the folder is named `Sent` on
 * PrivateEmail (not `Sent Items`).
 */
export async function appendSent(_rawMessage: string | Buffer): Promise<void> {
  console.log('[imap] appendSent: not implemented (phase-9 stub)');
}