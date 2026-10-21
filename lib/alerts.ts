// lib/alerts.ts
//
// Repeat-suppression for the Discord error alert (api/poll.ts).
//
// The poller runs every 15 minutes. Before this module, any sustained
// failure meant four identical Discord posts an hour (six at the old
// 10-minute cadence) for as long as it lasted — during the 2026-08-13 PrivateEmail outage that was ~20 posts
// saying nothing new, which is how an alert channel becomes noise people
// mute. The rule here: post the first occurrence immediately, then stay
// quiet until the reminder interval elapses, then post a reminder that
// says how long it has been going on.
//
// Two properties matter more than the volume reduction:
//   1. A CHANGED failure always posts immediately. Suppression keys off a
//      fingerprint of what broke, so a new problem arriving during an
//      ongoing one is never swallowed.
//   2. Recovery is announced. If you suppress the repeats you must tell
//      the reader when it stopped, or silence becomes ambiguous — still
//      broken, or fixed?
//
// The decision is a pure function (decideAlert) so the interesting
// behavior is unit-testable without a database or a Discord token.

import { eq } from 'drizzle-orm';
import { getDb } from './db.js';
import { alertState, type AlertStateRow } from '../db/schema.js';
import type { RunSummary } from './logging.js';

/**
 * How long an unchanged failure stays quiet between reminders. One hour
 * against a 15-minute cron means a sustained outage costs 1 post/hour
 * instead of 4, while still proving the condition is live.
 */
export const REMINDER_INTERVAL_MS = 60 * 60 * 1000;

// ---- Fingerprinting -------------------------------------------------------

/**
 * Collapse the volatile parts of an error message so the same underlying
 * failure fingerprints identically across runs. Numbers are the main
 * offender: UIDs, ports, IPs, byte counts and epoch millis all vary run to
 * run for what is obviously one condition (`connect ETIMEDOUT
 * 198.54.122.135:993` must not read as new when the resolver hands back a
 * different A record).
 */
function normalize(message: string): string {
  return message
    .toLowerCase()
    .replace(/\d+/g, '#')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/**
 * Digest of everything about a run that would trigger an alert, or null
 * when the run is clean (nothing to report). Built from the DISTINCT set
 * of stage+normalized-message pairs, sorted, so ordering and per-message
 * repetition don't perturb it — a batch where 10 messages all fail to
 * classify fingerprints the same as one where 3 do.
 *
 * The age-cutoff and filter-drift conditions participate too, since
 * api/poll.ts alerts on them alongside errors; they're folded in as
 * presence flags rather than counts, so a drift count ticking 2 -> 3
 * doesn't re-post.
 */
export function fingerprintRun(s: RunSummary): string | null {
  const parts = new Set<string>();
  for (const e of s.errors) {
    parts.add(`${e.stage}:${normalize(e.message)}`);
  }
  if (s.skippedByAgeCutoff > 0) parts.add('age-cutoff');
  if (s.filterDriftWarnings.length > 0) parts.add('filter-drift');
  if (parts.size === 0) return null;
  return [...parts].sort().join('|');
}

// ---- Decision -------------------------------------------------------------

export type AlertDecision =
  /** Nothing wrong, nothing outstanding — stay silent. */
  | { action: 'none' }
  /** A condition not currently being reported. Post it. */
  | { action: 'post'; occurrences: 1 }
  /** Same condition, reminder interval elapsed. Post with duration context. */
  | { action: 'remind'; occurrences: number; firstSeenAt: Date }
  /** Same condition, still inside the quiet window. Count it, say nothing. */
  | { action: 'suppress'; occurrences: number }
  /** A previously-reported condition has cleared. Announce the recovery. */
  | { action: 'recovered'; occurrences: number; firstSeenAt: Date };

/**
 * Decide what to do about this run's alert condition given what we last
 * reported. Pure — all clock and storage access is the caller's job.
 *
 * `prior` is the stored state for this alert key, or null when nothing is
 * outstanding (first ever run, or the last run was clean). Callers that
 * cannot reach storage should pass null: that degrades to posting every
 * run, which is the old behavior and strictly safer than going silent.
 */
export function decideAlert(params: {
  fingerprint: string | null;
  prior: Pick<AlertStateRow, 'fingerprint' | 'occurrences' | 'firstSeenAt' | 'lastPostedAt'> | null;
  now: Date;
  reminderIntervalMs?: number;
}): AlertDecision {
  const { fingerprint, prior, now } = params;
  const interval = params.reminderIntervalMs ?? REMINDER_INTERVAL_MS;

  if (fingerprint === null) {
    // Clean run. Only interesting if we'd previously reported something.
    if (!prior) return { action: 'none' };
    return {
      action: 'recovered',
      occurrences: prior.occurrences,
      firstSeenAt: prior.firstSeenAt,
    };
  }

  // A different failure than the one outstanding (or nothing outstanding):
  // always post, so a new problem is never masked by an ongoing one.
  if (!prior || prior.fingerprint !== fingerprint) {
    return { action: 'post', occurrences: 1 };
  }

  const occurrences = prior.occurrences + 1;
  const quietFor = now.getTime() - prior.lastPostedAt.getTime();
  if (quietFor >= interval) {
    return { action: 'remind', occurrences, firstSeenAt: prior.firstSeenAt };
  }
  return { action: 'suppress', occurrences };
}

/**
 * "3h 20m" / "12m" — how long a condition has been going on, for the
 * reminder and recovery lines. Sub-minute durations round to "just now"
 * rather than showing a misleading 0m.
 */
export function humanizeDuration(ms: number): string {
  const totalMinutes = Math.floor(ms / 60_000);
  if (totalMinutes < 1) return 'just now';
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

// ---- Persistence ----------------------------------------------------------

const db = () => getDb();

/** Current alert state for a key, or null when nothing is outstanding. */
export async function loadAlertState(key: string): Promise<AlertStateRow | null> {
  const rows = await db().select().from(alertState).where(eq(alertState.key, key)).limit(1);
  return rows[0] ?? null;
}

/**
 * Record the outstanding condition.
 *
 * `postedNow` distinguishes a run we actually posted (which resets the
 * quiet window) from a suppressed one (which must NOT, or the reminder
 * would never come due).
 *
 * `firstSeenAt` anchors the "going on for 3h" duration, so the caller
 * passes the prior value while a condition continues and `now` when it's
 * a fresh one. Deriving it here isn't possible — by upsert time we can no
 * longer tell a continuation from a replacement.
 */
export async function saveAlertState(
  key: string,
  params: {
    fingerprint: string;
    occurrences: number;
    firstSeenAt: Date;
    now: Date;
    postedNow: boolean;
  },
): Promise<void> {
  const { fingerprint, occurrences, firstSeenAt, now, postedNow } = params;
  await db()
    .insert(alertState)
    .values({
      key,
      fingerprint,
      occurrences,
      firstSeenAt,
      lastPostedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: alertState.key,
      set: {
        fingerprint,
        occurrences,
        firstSeenAt,
        updatedAt: now,
        ...(postedNow ? { lastPostedAt: now } : {}),
      },
    });
}

/** Drop the outstanding condition (it recovered, or it changed). */
export async function clearAlertState(key: string): Promise<void> {
  await db().delete(alertState).where(eq(alertState.key, key));
}
