import { ImapFlow, type ImapFlowOptions, type FetchMessageObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import { getEnv } from './env.js';

// ---- Public types ---------------------------------------------------------

export interface FetchedMessage {
  uid: number;
  messageId: string | undefined;
  fromAddr: string;
  fromName: string | undefined;
  /** Reply-To header, when present. For most senders this is undefined and
   *  replies go to fromAddr. For automated senders that wrap a real human
   *  (Web3Forms, mailing lists, ticketing systems), this holds the actual
   *  submitter's address and is what an outbound reply MUST be addressed to.
   *  See lib/mail/recipient.ts replyRecipient(). */
  replyTo: string | undefined;
  subject: string | undefined;
  text: string;
  textSnippet: string;          // raw text truncated to ~8k for downstream cleaning
  receivedAt: Date;
  inReplyTo: string | undefined;
  references: string | undefined;
  /** Content-Type header, used by the bounce pre-filter to detect
   *  multipart/report delivery-status notifications (RFC 3464). */
  contentType: string | undefined;
  /** Set when mailparser could not parse this message. The fetch
   *  generators NEVER throw on a single bad message — a throw escapes the
   *  consumer's `for await`, leaves no row for that UID, and so the cursor
   *  never advances past it: every later poll re-fetches it, throws again,
   *  and processes nothing (permanent head-of-line block, no alert). We
   *  yield a degraded message with this field set instead, and the runner
   *  records an error row so the cursor CAN move on. See SPEC §3.5. */
  parseError: string | undefined;
}

export interface FetchSinceOpts {
  /** Cap on messages per fetch call. Helps keep serverless runs bounded. */
  limit?: number;
  /** Only yield messages received since this date (inclusive). Older
   *  messages are skipped entirely — used by the incremental poller to
   *  avoid re-walking months of ancient mail when last_uid starts at 0. */
  since?: Date;
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
    // ImapFlow defaults to a 300000ms (5 minute) socket timeout. In a
    // serverless function with a much shorter maxDuration, a stalled
    // connection would otherwise sit there for most of 5 minutes before
    // erroring (observed live during Phase 5 verification) — way past any
    // sane function budget. Fail fast instead so the existing try/catch
    // in api/poll.ts gets a chance to record the error and persist
    // whatever progress was already made.
    socketTimeout: 30_000,
    // ImapFlow's own defaults here are 90s (TCP connect) and 16s (server
    // greeting), both far too generous for a function that normally
    // finishes the entire poll in ~2s. mail.privateemail.com intermittently
    // stalls the accept -> greeting handoff for ~9s and sometimes resets
    // the socket instead of completing it (see connectWithRetry below), so
    // we want a stalled attempt abandoned early enough to leave room for a
    // retry inside the same run rather than nursed along to 90s.
    connectionTimeout: 15_000,
    greetingTimeout: 12_000,
  };
}

/** Total connect attempts (1 initial + 2 retries) before giving up. */
const CONNECT_ATTEMPTS = 3;

/** Base backoff between connect attempts; doubles each retry (0.5s, 1s). */
const CONNECT_RETRY_BASE_MS = 500;

/**
 * Hard ceiling on a single connect attempt. ImapFlow's connect() walks
 * several phases (TCP, TLS, greeting, CAPABILITY, LOGIN) each with its own
 * timer, so the phase timeouts alone can compound past what a 120s
 * maxDuration can absorb across three attempts. This bounds one attempt
 * outright: 3 x 15s worst case still leaves the batch most of its budget.
 */
const CONNECT_ATTEMPT_TIMEOUT_MS = 15_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Open an ImapFlow connection. Caller MUST guard with try/finally calling
 * client.logout() — or use withImap() below.
 *
 * ImapFlow's `error` event has no default listener; Node throws and kills
 * the whole process if one ever fires unhandled (e.g. a socket timeout
 * mid-fetch — observed live during Phase 5 verification). The listener
 * here only logs: the same error also rejects whatever command was in
 * flight, which is what propagates to the caller's try/catch.
 */
export function connectImap(): ImapFlow {
  const client = new ImapFlow(baseOptions());
  client.on('error', (err: Error) => {
    console.error('[imap] connection error:', err.message);
  });
  return client;
}

/**
 * Open a connection, retrying the connect handshake on a FRESH socket when
 * it fails or stalls.
 *
 * Why: mail.privateemail.com (a single A record, 198.54.122.135) has a
 * flaky frontend -> backend mailbox handoff. Measured against it on
 * 2026-08-31, a healthy connect+login is ~900ms; in a sample of 8 probes
 * one stalled for 9127ms. Most such stalls eventually complete, and some
 * get reset by the server instead (`read ECONNRESET` — the production run
 * that prompted this took 10931ms before failing that way, matching the
 * stall almost exactly). Before this, one such reset failed the entire
 * 10-minute cron tick and cost two Discord alerts — the error, then the
 * "recovered" note on the next tick. The stall is per-connection and
 * random, so a second attempt on a new socket almost always succeeds.
 *
 * Only the handshake is retried. The caller's callback is NEVER re-run: it
 * performs side effects (row inserts, Discord card posts, \\Seen flagging)
 * that are not idempotent, so retrying it could double-post.
 */
async function connectWithRetry(): Promise<ImapFlow> {
  let lastErr: Error | undefined;

  for (let attempt = 1; attempt <= CONNECT_ATTEMPTS; attempt++) {
    const client = connectImap();
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        client.connect(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`connect exceeded ${CONNECT_ATTEMPT_TIMEOUT_MS}ms`)),
            CONNECT_ATTEMPT_TIMEOUT_MS,
          );
        }),
      ]);
      if (attempt > 1) {
        console.warn(`[imap] connect succeeded on attempt ${attempt}/${CONNECT_ATTEMPTS}`);
      }
      return client;
    } catch (err) {
      lastErr = err as Error;
      // Always tear the half-open socket down before trying again, or a
      // timed-out attempt leaks a live connection that keeps counting
      // against the server's per-account connection limit.
      try {
        client.close();
      } catch {
        /* already dead */
      }
      if (attempt === CONNECT_ATTEMPTS) break;
      const delay = CONNECT_RETRY_BASE_MS * 2 ** (attempt - 1);
      console.warn(
        `[imap] connect attempt ${attempt}/${CONNECT_ATTEMPTS} failed (${lastErr.message}); retrying in ${delay}ms`,
      );
      await sleep(delay);
    } finally {
      clearTimeout(timer);
    }
  }

  throw new Error(
    `imap connect failed after ${CONNECT_ATTEMPTS} attempts: ${lastErr?.message ?? 'unknown error'}`,
  );
}

/**
 * Scoped helper: opens a connection (retrying the handshake — see
 * connectWithRetry), runs the callback with the client, always closes the
 * connection in finally.
 */
export async function withImap<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = await connectWithRetry();
  try {
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

  /** Coerce a mailparser HeaderValue (string | string[] | undefined) to a
   *  single string when present, for headers we surface on FetchedMessage. */
  const normalizeHeader = (v: unknown): string | undefined => {
    if (typeof v === 'string' && v.length > 0) return v;
    if (Array.isArray(v) && typeof v[0] === 'string') return v[0] as string;
    return undefined;
  };

  const fromValue = parsed.from?.value?.[0];
  const fromAddr = fromValue?.address ?? '';
  const fromName = fromValue?.name;
  // Reply-To: when present, this is the address a reply must actually go
  // to (e.g. Web3Forms notifications carry From=notify@web3forms.com but
  // Reply-To=<the real submitter>). Without this, every approved reply to
  // a form submission gets mailed back to the notification bot instead of
  // the human who wrote in. See lib/mail/recipient.ts.
  const replyToValue = parsed.replyTo?.value?.[0];
  const replyTo = replyToValue?.address ?? undefined;
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
    replyTo,
    subject: parsed.subject ?? undefined,
    text,
    textSnippet: text.slice(0, 8000),
    receivedAt,
    inReplyTo: parsed.inReplyTo ?? undefined,
    references,
    contentType: normalizeHeader(parsed.headers?.get('content-type')),
    parseError: undefined,
  };
}

/**
 * Degraded stand-in for a message mailparser could not handle. Carries
 * only what the IMAP envelope gave us, plus `parseError` so the runner
 * writes an error row and the cursor can advance past it. Never throws.
 *
 * This exists so a single malformed message cannot block the pipeline —
 * see FetchedMessage.parseError and SPEC §3.5.
 */
function degradedMessage(raw: FetchMessageObject, err: Error): FetchedMessage {
  const envFrom = raw.envelope?.from?.[0];
  return {
    uid: raw.uid,
    // No Message-ID we can trust; the runner synthesizes `no-message-id:<uid>`
    // when this is undefined, which also makes the retry on the next poll
    // dedupe cleanly instead of inserting a second row.
    messageId: undefined,
    fromAddr: envFrom?.address ?? '',
    fromName: envFrom?.name ?? undefined,
    replyTo: undefined,
    subject: raw.envelope?.subject ?? undefined,
    text: '',
    textSnippet: '',
    receivedAt: raw.internalDate instanceof Date ? raw.internalDate : new Date(),
    inReplyTo: undefined,
    references: undefined,
    contentType: undefined,
    parseError: err.message,
  };
}

/**
 * Parse a fetched message, never throwing: on a parse failure, yields a
 * degraded message carrying `parseError`. Used by both fetch generators so
 * neither can die mid-iteration on one bad message.
 */
async function parseFetchedSafe(raw: FetchMessageObject): Promise<FetchedMessage> {
  try {
    return await parseFetched(raw);
  } catch (err) {
    const e = err as Error;
    console.error(`[imap] parse failed for uid=${raw.uid}: ${e.message}`);
    return degradedMessage(raw, e);
  }
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
  // Guard rail: ImapFlow's mailbox lock is a strict per-connection mutex —
  // at most one lock may be held at a time. Any code that tries to acquire
  // a second lock on the same client while one is held will deadlock
  // silently (no timeout by default; the socket eventually times out at
  // 30s and tears the connection down, masking the real cause). We pass
  // an explicit acquireTimeout so any future accidental nesting fails
  // loudly in seconds instead. See docs/SPEC_TRIAGE_FIXES.md §1.2.
  const lock = await client.getMailboxLock(mailbox, { readOnly: true, acquireTimeout: 15_000 });
  try {
    // Build the search criteria. We always constrain by UID > lastUid;
    // when `since` is set, also constrain by internal date so we don't
    // walk months of ancient mail on a cold cursor (last_uid=0).
    const searchCriteria: Record<string, unknown> = { uid: `${lastUid + 1}:*` };
    if (opts.since) {
      searchCriteria.since = opts.since;
    }

    let uids: number[] | undefined;
    if (opts.limit || opts.since) {
      const found = await client.search(searchCriteria, { uid: true });
      uids = (Array.isArray(found) ? found : []).filter((u) => u > lastUid);
      if (uids.length === 0) return;
      uids.sort((a, b) => a - b);
      if (opts.limit) uids = uids.slice(0, opts.limit);
    }

    const range = uids ? uids.join(',') : `${lastUid + 1}:*`;
    for await (const raw of client.fetch(range, FETCH_QUERY, { uid: true })) {
      if (raw.uid <= lastUid) continue;
      // Defensive: when no `since` filter is set, the search range may
      // include messages older than the cutoff if the server's UID range
      // reordering kicked in (RFC 3501 §6.4.8). We already trust
      // `internalDate` for the search; this second check is belt-and-
      // suspenders for servers that don't honor `since` precisely.
      if (opts.since && raw.internalDate instanceof Date && raw.internalDate < opts.since) {
        continue;
      }
      yield await parseFetchedSafe(raw);
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
 * assert peek state. Reading via source-fetch is still peek-style (no
 * \Seen set if it wasn't already there), but finding \Seen already
 * present is expected and not an invariant violation.
 */
export async function* fetchByDateRange(
  client: ImapFlow,
  mailbox: string,
  since: Date,
  opts: FetchByDateOpts = {},
): AsyncIterableIterator<FetchedMessage> {
  // Guard rail: see fetchSinceUid comment. Mutex must not be nested.
  const lock = await client.getMailboxLock(mailbox, { readOnly: true, acquireTimeout: 15_000 });
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
        yield await parseFetchedSafe(raw);
      }
    }
  } finally {
    lock.release();
  }
}

/**
 * Explicitly set the \\Seen flag on a message. This is one of the ONLY
 * operations in this module that marks a message read (the other is
 * markSeenBatch below). Per the plan, classification never sets \\Seen —
 * only deterministic pre-filter matches (when their *_MARK_READ config is
 * true) and Approve/Reject in Discord do.
 *
 * IMPORTANT: ImapFlow's mailbox lock is a strict per-connection mutex —
 * at most one lock may be held at a time. Calling markSeen (or
 * markSeenBatch) while a getMailboxLock is already held on the SAME
 * client deadlocks: the inner acquire waits forever for a lock that
 * cannot be released until the caller's loop finishes. The
 * `acquireTimeout: 15_000` guard below turns this into a loud 15s failure
 * instead of a silent 30s socket-timeout connection kill.
 *
 * Callers that need to mark messages read while iterating fetchSinceUid
 * MUST use the batched path: collect UIDs during the loop, then call
 * markSeenBatch after the generator is exhausted (lock released). See
 * api/poll.ts and docs/SPEC_TRIAGE_FIXES.md §1.2-1.3.
 */
export async function markSeen(client: ImapFlow, mailbox: string, uid: number): Promise<void> {
  const lock = await client.getMailboxLock(mailbox, { readOnly: false, acquireTimeout: 15_000 });
  try {
    await client.messageFlagsAdd(uid, ['\\Seen'], { uid: true });
  } finally {
    lock.release();
  }
}

/**
 * Flag many UIDs \\Seen in as few IMAP commands as possible. Must NOT be
 * called while another mailbox lock is held on the same client (ImapFlow
 * locks are a strict per-connection mutex — see markSeen's doc comment).
 * Intended for the poller's end-of-batch flush: collect UIDs whose routing
 * decision said markRead during the fetch loop, then call this once after
 * the generator completes and the fetch lock has been released.
 *
 * Chunks at 500 UIDs per command (same ceiling as scripts/mark-all-read.ts)
 * so a 25-message batch is a single round-trip and a 10k-message drain
 * stays well under any per-command timeout. Empty input is a no-op.
 */
export async function markSeenBatch(
  client: ImapFlow,
  mailbox: string,
  uids: number[],
): Promise<void> {
  if (uids.length === 0) return;
  const lock = await client.getMailboxLock(mailbox, { readOnly: false, acquireTimeout: 15_000 });
  try {
    const CHUNK = 500;
    for (let i = 0; i < uids.length; i += CHUNK) {
      const chunk = uids.slice(i, i + CHUNK);
      const range = chunk.join(',');
      await client.messageFlagsAdd(range, ['\\Seen'], { uid: true });
    }
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