import type { VercelRequest, VercelResponse } from '@vercel/node';
import { eq } from 'drizzle-orm';
import { fetchSinceUid, withImap, markSeenBatch } from '../lib/imap.js';
import { getEnv } from '../lib/env.js';
import { getDb } from '../lib/db.js';
import { emailQueue, type AlertStateRow } from '../db/schema.js';
import {
  incrementalPolicy,
  loadSyncState,
  saveSyncState,
  runBatch,
  newRunSummary,
  finish,
  type CardPoster,
} from '../lib/poll/runner.js';
import { postCard } from '../lib/discord/rest.js';
import { toJSON, toDiscordLine } from '../lib/logging.js';
import {
  fingerprintRun,
  decideAlert,
  humanizeDuration,
  loadAlertState,
  saveAlertState,
  clearAlertState,
  REMINDER_INTERVAL_MS,
} from '../lib/alerts.js';
import { getDiscordEnv } from '../types/env.js';

/**
 * Cap on messages fetched per cron tick. Cron fires every 10 minutes (see
 * vercel.json), so a smaller batch just means backlog drains over more
 * ticks rather than risking the function's maxDuration. Live testing
 * during Phase 5 review showed Gemini-bound per-message cost plus IMAP
 * round-trips can push a 25-message batch well past 60s — see
 * `maxDuration` in vercel.json, raised alongside this for headroom.
 */
const POLL_BATCH_LIMIT = 10;

/**
 * Only fetch mail received within the last N days. This keeps a cold
 * cursor (last_uid=0) from re-walking months of ancient mail — anything
 * older than this cutoff is left in the inbox untouched by the poller.
 * Backlog modes (Phase 8) cover intentional historical sweeps by date
 * range. Default 60 days matches the backlog window in plan §10.
 */
const POLL_MAX_AGE_DAYS = 60;

function cutoffDate(): Date {
  const d = new Date();
  d.setDate(d.getDate() - POLL_MAX_AGE_DAYS);
  d.setHours(0, 0, 0, 0);
  return d;
}

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
 *      runner does NOT call markSeen inline (that would nest a write lock
 *      inside the fetch generator's read-only lock on the same client and
 *      deadlock — see lib/imap.ts markSeen doc). Instead it collects the
 *      UIDs whose routing decision said markRead and returns them.
 *   5. After the generator exhausts (read-only lock released), call
 *      markSeenBatch on the collected UIDs — one IMAP command per 500 UIDs.
 *   6. Update email_sync_state.last_uid to the highest UID successfully
 *      persisted (NOT processed — a row that failed to insert does NOT
 *      advance the cursor; the next run retries it).
 *   7. Return a RunSummary JSON.
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

  // Phase 6: real card poster. On a 'post' routing decision, sends the
  // approval card to Discord and saves the returned message id back onto
  // the email_queue row. Discord creds are required here — if they're
  // missing we skip posting and record an error rather than crashing the
  // whole poll.
  const cardPoster: CardPoster = async (ctx) => {
    const posted = await postCard({
      id: ctx.rowId,
      fromAddr: ctx.fromAddr,
      fromName: ctx.fromName ?? null,
      replyTo: ctx.replyTo ?? null,
      subject: ctx.subject ?? null,
      category: ctx.category,
      draftReply: ctx.draftReply,
      bodySnippet: ctx.bodySnippet,
      receivedAt: ctx.receivedAt,
      routing: ctx.routing ?? null,
    });
    await getDb()
      .update(emailQueue)
      .set({ discordMessageId: posted.messageId, updatedAt: new Date() })
      .where(eq(emailQueue.id, ctx.rowId));
  };

  // 2. Fetch + process. We hold one IMAP connection for the whole batch.
  // runBatch collects the UIDs whose routing decision said markRead but
  // does NOT call markSeen inline (that would nest a write lock inside
  // the fetch generator's read-only lock on the same client and deadlock
  // — see lib/imap.ts markSeen doc + SPEC §1.2). We flush them in one
  // markSeenBatch call after runBatch returns, when the fetch lock has
  // been released.
  //
  // runBatch mutates summary.highestPersistedUid as each message lands, so
  // it holds the right value to advance the cursor to even if the batch
  // throws partway through (e.g. the IMAP connection drops on message 20
  // of 25) — without this, a mid-batch failure would silently discard
  // already-persisted progress and leave last_uid stuck, forcing every
  // later run to re-walk the same already-handled messages via dedupe.
  let seenUids: number[] = [];
  try {
    await withImap(async (client) => {
      // SPEC §3.7: detect mail this run is about to skip silently. The
      // fetch below constrains on BOTH `uid > lastUid` and `since cutoff`,
      // so a message ABOVE the cursor but OLDER than the cutoff is never
      // yielded, never gets a row, and yet the cursor still advances past
      // it once any newer message persists. That is the silent-drop path:
      // no row, no log, no alert.
      //
      // The window must be UIDs ABOVE the cursor. Counting UIDs at or
      // below it would count already-processed mail (everything below the
      // cursor has a row by definition), which in a mailbox with any
      // history is a permanently non-zero number — and since a non-zero
      // count fires the Discord alert below, that would post an alert on
      // every single cron tick. Normally this count is 0 and only goes
      // non-zero in the real failure mode (cron down longer than the
      // cutoff, or an old message arriving with a fresh UID).
      try {
        const lock = await client.getMailboxLock(mailbox, { readOnly: true, acquireTimeout: 15_000 });
        try {
          const skipped = await client.search(
            { uid: `${lastUidBefore + 1}:*`, before: cutoffDate() },
            { uid: true },
          );
          // RFC 3501 §6.4.8: `n:*` where n exceeds every existing UID can
          // come back with the highest existing UID instead of empty, so
          // drop anything that isn't actually above the cursor.
          const genuinelySkipped = (Array.isArray(skipped) ? skipped : []).filter(
            (u) => u > lastUidBefore,
          );
          summary.skippedByAgeCutoff = genuinelySkipped.length;
          if (summary.skippedByAgeCutoff > 0) {
            console.warn(
              `[poll] ${summary.skippedByAgeCutoff} message(s) above cursor ${lastUidBefore} are older than ${POLL_MAX_AGE_DAYS} days and will NOT be processed (uids: ${genuinelySkipped.slice(0, 20).join(',')}). Raise POLL_MAX_AGE_DAYS or handle them manually.`,
            );
          }
        } finally {
          lock.release();
        }
      } catch (err) {
        // Non-fatal: the age-cutoff check is a guard rail, not a
        // prerequisite for the main poll path.
        const e = err as Error;
        console.warn(`[poll] age-cutoff check failed (non-fatal): ${e.message}`);
      }

      const iter = fetchSinceUid(client, mailbox, lastUidBefore, {
        limit: POLL_BATCH_LIMIT,
        since: cutoffDate(),
      });
      const result = await runBatch(iter, client, mailbox, incrementalPolicy, summary, cardPoster);
      seenUids = result.seenUids;

      // Flush all markRead UIDs in one batched IMAP command. The fetch
      // generator is now exhausted, so the read-only mailbox lock is
      // released and markSeenBatch can safely acquire its own write lock
      // on this same client. A failure here is non-fatal: rows are already
      // persisted and the cursor will advance; the only consequence is
      // those messages stay unread in webmail until the next run or the
      // reconcile-seen.ts one-time drain.
      if (seenUids.length > 0) {
        try {
          await markSeenBatch(client, mailbox, seenUids);
          summary.markedRead = seenUids.length;
        } catch (err) {
          const e = err as Error;
          recordError(summary, { stage: 'markseen', message: `markSeenBatch failed: ${e.message}` });
        }
      }
    });
  } catch (err) {
    const e = err as Error;
    // IMAP connection or fetch-level error. Record and continue below so we
    // still return a summary and advance the cursor to whatever was
    // genuinely persisted before the failure.
    recordError(summary, { stage: 'imap', message: e.message });
  }

  // 3. Advance the cursor ONLY if at least one new UID was persisted, on
  // EITHER path above (clean completion or mid-batch throw) — see comment
  // above on why summary.highestPersistedUid survives a throw.
  const { highestPersistedUid } = summary;
  if (highestPersistedUid !== null && highestPersistedUid > lastUidBefore) {
    try {
      await saveSyncState(key, highestPersistedUid);
      summary.lastUidAfter = highestPersistedUid;
    } catch (err) {
      const e = err as Error;
      recordError(summary, { stage: 'db-sync-state', message: e.message });
      summary.lastUidAfter = lastUidBefore;
    }
  } else {
    summary.lastUidAfter = lastUidBefore;
  }

  finish(summary, summary.lastUidAfter, null);
  const elapsed = Date.now() - startedAt.getTime();
  console.log(
    `[poll] done in ${elapsed}ms — processed=${summary.processed} errors=${summary.errors.length} markedRead=${summary.markedRead} skippedByAge=${summary.skippedByAgeCutoff} lastUid ${lastUidBefore}->${summary.lastUidAfter}`,
  );

  // SPEC §3.9 / Phase 9 error alert: if a poll run has any errors, any
  // age-cutoff-skipped mail, or any filter-drift warnings, post a
  // one-liner to the Discord approval channel so it surfaces somewhere a
  // human actually looks, rather than sitting in Vercel logs nobody
  // watches. Best-effort — a Discord outage here must not fail the poll.
  //
  // Repeat-suppressed via lib/alerts.ts: cron fires every 10 minutes, so
  // a sustained failure would otherwise post the same line six times an
  // hour until someone muted the channel. A changed condition still posts
  // immediately, and recovery is announced. See lib/alerts.ts.
  await postAlert(summary, key);

  // Always 200 with the summary; a 500 would make Vercel's cron retry logic
  // fire and we don't want that for partial-success runs. Real catastrophic
  // failures (IMAP down) still return 200 with the error recorded; the
  // Discord alert above handles "errors > 0".
  res.status(200).json(toJSON(summary));
}

/** Human-readable form of the alert quiet window, for the reminder text. */
const SUPPRESSION_WINDOW_LABEL = humanizeDuration(REMINDER_INTERVAL_MS);

/** Send a message to the Discord approval channel. Throws on config gaps
 *  so the caller's best-effort catch logs them. */
async function postToDiscord(content: string): Promise<void> {
  const { DISCORD_CHANNEL_ID, DISCORD_BOT_TOKEN } = getDiscordEnv();
  await fetch(`https://discord.com/api/v10/channels/${DISCORD_CHANNEL_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content }),
  });
}

/**
 * Post the run's error alert to Discord, suppressing repeats of an
 * unchanged condition (see lib/alerts.ts).
 *
 * Every failure path here degrades toward posting rather than toward
 * silence: if the alert_state table is unreachable we post unconditionally
 * (the pre-suppression behavior), because a duplicate alert is a nuisance
 * while a swallowed one is a missed outage. The whole thing is best-effort
 * — the poll has already done its real work by this point.
 */
async function postAlert(summary: ReturnType<typeof newRunSummary>, key: string): Promise<void> {
  const fingerprint = fingerprintRun(summary);

  let prior: AlertStateRow | null = null;
  let stateAvailable = true;
  try {
    prior = await loadAlertState(key);
  } catch (err) {
    stateAvailable = false;
    console.warn('[poll] alert state unavailable, posting unsuppressed:', (err as Error).message);
  }

  const now = new Date();
  const decision = stateAvailable
    ? decideAlert({ fingerprint, prior, now })
    // No state: post whenever there's something to report, never suppress.
    : fingerprint === null
      ? ({ action: 'none' } as const)
      : ({ action: 'post', occurrences: 1 } as const);

  if (decision.action === 'none') return;

  if (decision.action === 'suppress') {
    console.log(
      `[poll] alert suppressed (unchanged condition, occurrence ${decision.occurrences}): ${fingerprint}`,
    );
    // Still record the tick so the reminder can cite an accurate count.
    if (stateAvailable && fingerprint) {
      try {
        await saveAlertState(key, {
          fingerprint,
          occurrences: decision.occurrences,
          firstSeenAt: prior?.firstSeenAt ?? now,
          now,
          postedNow: false,
        });
      } catch (err) {
        console.warn('[poll] alert state save failed:', (err as Error).message);
      }
    }
    return;
  }

  if (decision.action === 'recovered') {
    const since = humanizeDuration(now.getTime() - decision.firstSeenAt.getTime());
    try {
      await postToDiscord(
        `✅ **recovered** ${key} — poll is clean again after ${decision.occurrences} failing run(s) over ${since}.`,
      );
    } catch (err) {
      console.warn('[poll] recovery Discord post failed:', (err as Error).message);
    }
    try {
      await clearAlertState(key);
    } catch (err) {
      console.warn('[poll] alert state clear failed:', (err as Error).message);
    }
    return;
  }

  // 'post' (new condition) or 'remind' (unchanged, quiet window elapsed).
  const parts = [toDiscordLine(summary)];
  if (summary.skippedByAgeCutoff > 0) {
    parts.push(`⚠️ ${summary.skippedByAgeCutoff} msgs older than ${POLL_MAX_AGE_DAYS}d skipped`);
  }
  if (summary.filterDriftWarnings.length > 0) {
    parts.push(
      `⚠️ ${summary.filterDriftWarnings.length} filter-drift warning(s) — check AUTOMATED_FORM_SUBJECTS`,
    );
  }
  if (decision.action === 'remind') {
    const since = humanizeDuration(now.getTime() - decision.firstSeenAt.getTime());
    parts.push(
      `\n_↻ still failing — ${decision.occurrences} runs over ${since}. Further identical alerts are suppressed for ${SUPPRESSION_WINDOW_LABEL}._`,
    );
  }

  try {
    await postToDiscord(parts.join(' '));
  } catch (err) {
    // Non-fatal: the poll itself succeeded; the alert is best-effort.
    console.warn('[poll] error-alert Discord post failed:', (err as Error).message);
    return; // Don't reset the quiet window on a post that never landed.
  }

  if (stateAvailable && fingerprint) {
    try {
      await saveAlertState(key, {
        fingerprint,
        occurrences: decision.occurrences,
        firstSeenAt: decision.action === 'remind' ? decision.firstSeenAt : now,
        now,
        postedNow: true,
      });
    } catch (err) {
      console.warn('[poll] alert state save failed:', (err as Error).message);
    }
  }
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