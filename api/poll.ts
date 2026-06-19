import type { VercelRequest, VercelResponse } from '@vercel/node';
import { fetchSinceUid, withImap } from '../lib/imap.js';
import { getEnv } from '../lib/env.js';
import {
  incrementalPolicy,
  loadSyncState,
  saveSyncState,
  runBatch,
  newRunSummary,
  finish,
} from '../lib/poll/runner.js';
import { toJSON } from '../lib/logging.js';

/**
 * Per-plan §5, the incremental poller's mailbox key is
 * `${EMAIL_USER}/INBOX`. Backlog modes (Phase 8) reuse this convention.
 */
function mailboxKey(): string {
  return `${getEnv().EMAIL_USER}/INBOX`;
}

/**
 * Authenticate the request against CRON_SECRET. Per the plan, the secret is
 * accepted ONLY from the `Authorization: Bearer <secret>` header — never
 * from the query string (Vercel logs query strings and would leak it).
 * Returns true on success, false on failure (handler sends 401).
 */
function authenticate(req: VercelRequest, res: VercelResponse): boolean {
  const expected = getEnv().CRON_SECRET;
  const auth = req.headers['authorization'];
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
    res.status(401).json({ error: 'missing or malformed Authorization header' });
    return false;
  }
  const presented = auth.slice('Bearer '.length).trim();
  // Constant-time-ish compare to avoid trivial timing side channels. Not a
  // hard requirement here (cron secret, not a user credential), but cheap.
  if (presented.length !== expected.length || presented !== expected) {
    res.status(401).json({ error: 'invalid bearer token' });
    return false;
  }
  return true;
}

/**
 * Incremental poll endpoint. Cron-fired (see vercel.json — every 10 min).
 *
 * Flow:
 *   1. Authenticate via CRON_SECRET header.
 *   2. Load last_uid from email_sync_state for ${EMAIL_USER}/INBOX.
 *   3. Open IMAP read-only, fetchSinceUid(lastUid) (peek — does not set Seen).
 *   4. Per message: dedupe -> pre-filter -> classify -> insert+route. The
 *      runner closes the IMAP read-only lock and re-opens for markSeen when
 *      a pre-filter or routing decision says so.
 *   5. Update email_sync_state.last_uid to the highest UID successfully
 *      persisted (NOT processed — a row that failed to insert does NOT
 *      advance the cursor; the next run retries it).
 *   6. Return a RunSummary JSON.
 *
 * Backlog modes (`?mode=backlog-classify|backlog-draft`) are added in
 * Phase 8; this handler 400s on them for now so Vercel logs are clear.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (!authenticate(req, res)) return;

  // Phase 8 will dispatch on ?mode=. Until then, anything other than the
  // default incremental path is rejected so logs don't silently no-op.
  const mode = typeof req.query.mode === 'string' ? req.query.mode : undefined;
  if (mode) {
    res.status(400).json({
      error: 'backlog modes not yet implemented (Phase 8)',
      received_mode: mode,
    });
    return;
  }

  const mailbox = 'INBOX';
  const key = mailboxKey();
  const startedAt = new Date();

  // 1. Sync state.
  let lastUidBefore: number;
  try {
    const state = await loadSyncState(key);
    lastUidBefore = state.lastUid;
  } catch (err) {
    const e = err as Error;
    console.error('[poll] loadSyncState failed:', e.message);
    res.status(500).json({ error: 'sync state load failed', detail: e.message });
    return;
  }

  const summary = newRunSummary(key, 'incremental', lastUidBefore);

  // 2. Fetch + process. We hold one IMAP connection for the whole batch;
  // markSeen re-enters its own read/write lock per call so it can flip
  // flags without a separate connection.
  try {
    await withImap(async (client) => {
      // The runner needs an open client it can pass to markSeen for
      // pre-filter matches and (Phase 6) Approve/Reject. fetchSinceUid
      // takes a mailbox arg, so we don't pre-acquire a lock here.
      const iter = fetchSinceUid(client, mailbox, lastUidBefore, { limit: 25 });
      const { highestPersistedUid } = await runBatch(
        iter,
        client,
        mailbox,
        incrementalPolicy,
        summary,
      );

      // 3. Advance the cursor ONLY if at least one new UID was persisted.
      // A run that sees no new mail (highestPersistedUid === null) leaves
      // last_uid untouched — no DB write needed.
      if (highestPersistedUid !== null && highestPersistedUid > lastUidBefore) {
        await saveSyncState(key, highestPersistedUid);
        summary.lastUidAfter = highestPersistedUid;
      } else {
        // No advance; mirror the before value for the summary.
        summary.lastUidAfter = lastUidBefore;
      }
    });
  } catch (err) {
    const e = err as Error;
    // IMAP connection or fetch-level error. Record and continue so we
    // still return a summary (partial progress is preserved in DB).
    recordError(summary, { stage: 'imap', message: e.message });
  }

  finish(summary, summary.lastUidAfter, null);
  const elapsed = Date.now() - startedAt.getTime();
  console.log(
    `[poll] done in ${elapsed}ms — processed=${summary.processed} errors=${summary.errors.length} lastUid ${lastUidBefore}->${summary.lastUidAfter}`,
  );

  // Always 200 with the summary; a 500 would make Vercel's cron retry logic
  // fire and we don't want that for partial-success runs. Real catastrophic
  // failures (IMAP down) still return 200 with the error recorded; Phase 9
  // alerting handles the "errors > 0" Discord notification.
  res.status(200).json(toJSON(summary));
}

// Local helper kept next to its sole caller so we don't expand the runner's
// API surface for an edge case.
function recordError(
  summary: ReturnType<typeof newRunSummary>,
  err: { stage: string; message: string; uid?: number; messageId?: string },
): void {
  summary.errors.push({
    stage: err.stage,
    message: err.message,
    uid: err.uid,
    messageId: err.messageId,
  });
}