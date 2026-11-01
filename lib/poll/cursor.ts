// lib/poll/cursor.ts
//
// Idle-poll shortcut. Every brand polls every 15 minutes, and the poll used
// to read email_sync_state from Neon before touching IMAP — 96 Neon wakes a
// day even when no mail arrived. This module lets a poll that finds nothing
// new finish without a single Neon query.
//
// How: after each full run we remember {lastUid, uidValidity, alertActive}
// in the Vercel runtime cache (no new service, no setup). The next run asks
// IMAP for STATUS (UIDNEXT UIDVALIDITY) and, if nothing sits above the
// cached cursor, returns early.
//
// The cache is only ever a hint. A miss, an expiry, an unreachable STATUS, a
// UIDVALIDITY change or an active alert all fall back to the original
// Neon-backed path, so the worst case is today's behaviour. It never skips
// mail: the test is "uidNext - 1 <= lastUid" (the same uid > lastUid rule the
// fetch uses), not UNSEEN, so mail read on a phone is still processed.

import { getCache } from '@vercel/functions';
import { withImap, type ImapAuth } from '../imap.js';

/**
 * How long a cached cursor is trusted. The entry is rewritten after every
 * full run, so this only bounds staleness if someone edits email_sync_state
 * by hand (e.g. resets last_uid to re-poll): the next Neon read happens
 * within this window.
 */
export const CURSOR_TTL_SECONDS = 6 * 60 * 60;

export interface PollCursor {
  lastUid: number;
  uidValidity: number;
  /** An error alert is open for this brand; a clean run must reach Neon to announce recovery. */
  alertActive: boolean;
}

export interface MailboxStatus {
  uidNext: number;
  uidValidity: number;
}

const cacheKey = (syncKey: string) => `poll-cursor:${syncKey}`;

function isCursor(v: unknown): v is PollCursor {
  if (typeof v !== 'object' || v === null) return false;
  const c = v as Record<string, unknown>;
  return (
    typeof c.lastUid === 'number' &&
    typeof c.uidValidity === 'number' &&
    typeof c.alertActive === 'boolean'
  );
}

/** Cached cursor, or null on a miss / malformed entry / cache error. */
export async function readCursor(syncKey: string): Promise<PollCursor | null> {
  try {
    const v = await getCache().get(cacheKey(syncKey));
    return isCursor(v) ? v : null;
  } catch (err) {
    console.warn('[poll] cursor cache read failed:', (err as Error).message);
    return null;
  }
}

/** Best-effort: a failed write only costs the next run a Neon read. */
export async function writeCursor(syncKey: string, cursor: PollCursor): Promise<void> {
  try {
    await getCache().set(cacheKey(syncKey), cursor, {
      ttl: CURSOR_TTL_SECONDS,
      name: cacheKey(syncKey),
    });
  } catch (err) {
    console.warn('[poll] cursor cache write failed:', (err as Error).message);
  }
}

/** IMAP STATUS on the mailbox: cheap, takes no mailbox lock, selects nothing. */
export async function fetchMailboxStatus(
  mailbox: string,
  auth?: ImapAuth,
): Promise<MailboxStatus> {
  return withImap(async (client) => {
    const s = await client.status(mailbox, { uidNext: true, uidValidity: true });
    if (typeof s.uidNext !== 'number' || s.uidValidity === undefined) {
      throw new Error('STATUS reply missing UIDNEXT/UIDVALIDITY');
    }
    return { uidNext: s.uidNext, uidValidity: Number(s.uidValidity) };
  }, auth);
}

/**
 * True only when it is certain there is nothing for the poll to do: the
 * mailbox is the same incarnation, no alert needs resolving, and no UID
 * exists above the cursor (UIDNEXT is one past the highest UID ever issued).
 */
export function canSkipPoll(cursor: PollCursor | null, status: MailboxStatus): boolean {
  if (!cursor || cursor.alertActive) return false;
  if (cursor.uidValidity !== status.uidValidity) return false;
  return status.uidNext - 1 <= cursor.lastUid;
}
