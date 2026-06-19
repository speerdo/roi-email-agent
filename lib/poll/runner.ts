// lib/poll/runner.ts
//
// Per-message pipeline shared by the incremental poller (Phase 5) and the
// backlog modes (Phase 8). One place owns:
//   - mailparser parse (already done by imap.ts; we receive FetchedMessage)
//   - message_id dedupe (skip duplicates already in email_queue)
//   - deterministic pre-filters (runPrefilters)
//   - Gemini classifyAndDraft (only when pre-filters don't match)
//   - row insert with status reflecting routing decision
//   - markSeen when a pre-filter's *_MARK_READ is true
//   - RunSummary accounting (counters, errors)
//
// Phase 5's incremental caller passes a RoutingPolicy that emits
// "would post card" log lines for reply-worthy mail; Phase 6 swaps that
// for a real postCard() call, and Phase 8's backlog modes pass their own
// no-card / no-draft policies.

import type { ImapFlow } from 'imapflow';
import { eq } from 'drizzle-orm';
import { getDb } from '../db.js';
import { emailQueue, emailSyncState } from '../../db/schema.js';
import { cleanBody } from '../mail/clean.js';
import { runPrefilters } from '../mail/prefilter.js';
import { classifyAndDraft, type ClassifyResult } from '../gemini/index.js';
import { markSeen } from '../imap.js';
import {
  type RunSummary,
  newRunSummary,
  bumpCategory,
  bumpSkipReason,
  bumpStatus,
  recordError,
  finish,
} from '../logging.js';
import type { FetchedMessage } from '../imap.js';

// Drizzle singleton, resolved lazily on first use so this module is safe
// to import from tests that haven't set DATABASE_URL (e.g. the matcher
// unit tests don't touch the runner).
const db = () => getDb();

// ---- Routing policy -------------------------------------------------------

/**
 * Decides what to do with a row AFTER classify/draft. The runner has already
 * inserted the row by this point; the policy only decides side effects
 * (post a card, markSeen, mutate status). Return values:
 *   - status to set on the row (e.g. 'pending', 'skipped', 'sent')
 *   - markRead: whether to call markSeen(uid) on the IMAP server
 *   - cardAction: 'post' | 'skip' — for Phase 5, 'post' just produces a log
 *     line; Phase 6 wires in real Discord posting.
 */
export interface RoutingDecision {
  status: 'pending' | 'skipped';
  markRead: boolean;
  cardAction: 'post' | 'skip';
  skipReason?: string;
}

export interface RoutingContext {
  /** The row that was just inserted into email_queue. */
  rowId: string;
  imapUid: number;
  category: string;
  shouldReply: boolean;
  draftReply: string;
}

export type RoutingPolicy = (ctx: RoutingContext) => RoutingDecision;

/**
 * Phase 5 incremental policy. Reply-worthy non-spam -> pending + would-post
 * card log; spam -> skipped + NO read (stays visible); everything else ->
 * skipped, no card. Cards themselves are wired in Phase 6.
 */
export const incrementalPolicy: RoutingPolicy = (ctx) => {
  if (ctx.shouldReply && ctx.category !== 'spam') {
    return { status: 'pending', markRead: false, cardAction: 'post' };
  }
  if (ctx.category === 'spam') {
    return {
      status: 'skipped',
      markRead: false,        // safety net: keep spam visible in webmail
      cardAction: 'skip',
      skipReason: 'spam',
    };
  }
  return {
    status: 'skipped',
    markRead: false,
    cardAction: 'skip',
    skipReason: `category:${ctx.category}:no_reply`,
  };
};

// ---- Per-message processing -----------------------------------------------

export interface ProcessMessageResult {
  status: 'inserted' | 'duplicate' | 'error';
  uid: number;
  rowId?: string;
  category?: string;
  shouldReply?: boolean;
}

/**
 * Process a single fetched message end-to-end:
 *   1. Dedupe by Message-ID (skip if already in email_queue).
 *   2. Run pre-filters; on match, insert skipped row + markSeen if asked.
 *   3. Otherwise: cleanBody -> classifyAndDraft -> insert row, apply
 *      routing policy, update row status, optionally markSeen.
 *
 * Errors are caught and recorded in the summary; the cursor is NOT advanced
 * past a message whose row insert failed (the caller handles that by only
 * updating last_uid on `status: 'inserted' | 'duplicate'`).
 *
 * Note on `client`: an open ImapFlow connection. We re-enter read/write locks
 * per-operation inside markSeen; reusing one connection across UIDs is fine
 * since getMailboxLock is per-call.
 *
 * Note on Message-ID presence: a message without a Message-ID is rare but
 * possible (some automated senders skip it). We still need to dedupe, so
 * we synthesize a stable key: `no-message-id:<uid>`. This keeps the unique
 * constraint satisfied without dropping the email.
 */
export async function processMessage(
  msg: FetchedMessage,
  client: ImapFlow,
  mailbox: string,
  policy: RoutingPolicy,
  summary: RunSummary,
): Promise<ProcessMessageResult> {
  summary.processed += 1;

  const messageId = msg.messageId?.trim() || `no-message-id:${msg.uid}`;
  const snippet = cleanBody(msg.textSnippet);

  // 1. Dedupe by message_id.
  try {
    const existing = await db()
      .select({ id: emailQueue.id })
      .from(emailQueue)
      .where(eq(emailQueue.messageId, messageId))
      .limit(1);
    if (existing.length > 0) {
      // Already processed. Do not re-classify, do not advance cursor past it
      // either way (caller treats 'duplicate' as already-handled, which is
      // fine — the row exists, last_uid can move forward).
      return { status: 'duplicate', uid: msg.uid };
    }
  } catch (err) {
    const e = err as Error;
    recordError(summary, {
      uid: msg.uid,
      messageId,
      stage: 'db-dedupe',
      message: e.message,
    });
    return { status: 'error', uid: msg.uid };
  }

  // 2. Pre-filters (deterministic, no LLM call).
  const pre = runPrefilters({
    subject: msg.subject ?? '',
    from: { address: msg.fromAddr, name: msg.fromName },
  });

  if (pre.matched) {
    const rowId = await insertRow({
      messageId,
      imapUid: msg.uid,
      fromAddr: msg.fromAddr,
      fromName: msg.fromName,
      subject: msg.subject,
      bodySnippet: snippet,
      category: pre.category,
      shouldReply: false,
      draftReply: null,
      status: 'skipped',
      skipReason: pre.skipReason,
      inReplyTo: msg.inReplyTo,
      emailReferences: msg.references,
      receivedAt: msg.receivedAt,
    });

    if (rowId === null) {
      return { status: 'error', uid: msg.uid };
    }

    bumpCategory(summary, pre.category);
    bumpSkipReason(summary, pre.skipReason);
    bumpStatus(summary, 'skipped');

    if (pre.markRead) {
      try {
        await markSeen(client, mailbox, msg.uid);
      } catch (err) {
        const e = err as Error;
        recordError(summary, {
          uid: msg.uid,
          messageId,
          stage: 'markseen',
          message: `pre-filter markSeen failed: ${e.message}`,
        });
        // Don't fail the whole message over a flag flip; the row is already
        // 'skipped' and the cursor can advance.
      }
    }
    return { status: 'inserted', uid: msg.uid, rowId, category: pre.category, shouldReply: false };
  }

  // 3. Gemini classify + draft.
  let classify: ClassifyResult;
  try {
    classify = await classifyAndDraft({
      from: msg.fromAddr,
      subject: msg.subject ?? '',
      snippet,
    });
  } catch (err) {
    const e = err as Error;
    recordError(summary, {
      uid: msg.uid,
      messageId,
      stage: 'classify',
      message: e.message,
    });
    // Insert an error row so it's visible in Neon and retried on next run
    // (the cursor does NOT advance past this UID when status='error').
    await insertRow({
      messageId,
      imapUid: msg.uid,
      fromAddr: msg.fromAddr,
      fromName: msg.fromName,
      subject: msg.subject,
      bodySnippet: snippet,
      category: null,
      shouldReply: false,
      draftReply: null,
      status: 'error',
      skipReason: null,
      errorDetail: `classify error: ${e.message}`,
      inReplyTo: msg.inReplyTo,
      emailReferences: msg.references,
      receivedAt: msg.receivedAt,
    });
    bumpStatus(summary, 'error');
    return { status: 'error', uid: msg.uid };
  }

  // 4. Insert the row as pending, then apply routing.
  const rowId = await insertRow({
    messageId,
    imapUid: msg.uid,
    fromAddr: msg.fromAddr,
    fromName: msg.fromName,
    subject: msg.subject,
    bodySnippet: snippet,
    category: classify.category,
    shouldReply: classify.should_reply,
    draftReply: classify.draft_reply || null,
    status: 'pending',
    skipReason: null,
    inReplyTo: msg.inReplyTo,
    emailReferences: msg.references,
    receivedAt: msg.receivedAt,
  });

  if (rowId === null) {
    return { status: 'error', uid: msg.uid };
  }

  bumpCategory(summary, classify.category);
  bumpStatus(summary, 'pending');

  // 5. Routing policy.
  const decision = policy({
    rowId,
    imapUid: msg.uid,
    category: classify.category,
    shouldReply: classify.should_reply,
    draftReply: classify.draft_reply,
  });

  if (decision.status !== 'pending') {
    // Update the row's status + skip reason.
    try {
      await db()
        .update(emailQueue)
        .set({
          status: decision.status,
          skipReason: decision.skipReason ?? null,
          updatedAt: new Date(),
        })
        .where(eq(emailQueue.id, rowId));
      bumpStatus(summary, decision.status);
    } catch (err) {
      const e = err as Error;
      recordError(summary, {
        uid: msg.uid,
        messageId,
        stage: 'db-route-update',
        message: e.message,
      });
    }
  }

  if (decision.cardAction === 'post') {
    // Phase 5 stub: real postCard lands in Phase 6. For now log so a
    // reviewer watching Vercel logs can see what WOULD have been carded.
    console.log(
      `[poll] would post card for row=${rowId} uid=${msg.uid} category=${classify.category}`,
    );
  }

  if (decision.markRead) {
    try {
      await markSeen(client, mailbox, msg.uid);
    } catch (err) {
      const e = err as Error;
      recordError(summary, {
        uid: msg.uid,
        messageId,
        stage: 'markseen',
        message: `route markSeen failed: ${e.message}`,
      });
    }
  }

  return {
    status: 'inserted',
    uid: msg.uid,
    rowId,
    category: classify.category,
    shouldReply: classify.should_reply,
  };
}

// ---- Row insert helper ----------------------------------------------------

interface InsertRowInput {
  messageId: string;
  imapUid: number;
  fromAddr: string;
  fromName?: string;
  subject?: string;
  bodySnippet: string;
  category: string | null;
  shouldReply: boolean;
  draftReply: string | null;
  status: 'pending' | 'skipped' | 'error';
  skipReason: string | null;
  errorDetail?: string;
  inReplyTo?: string;
  emailReferences?: string;
  receivedAt: Date;
}

/**
 * Inserts an email_queue row. Returns the new row id, or null on failure
 * (caller records the error). We use the returning()() of drizzle to get
 * the generated id back without a second round-trip.
 */
async function insertRow(input: InsertRowInput): Promise<string | null> {
  try {
    const inserted = await db()
      .insert(emailQueue)
      .values({
        messageId: input.messageId,
        imapUid: input.imapUid,
        fromAddr: input.fromAddr,
        fromName: input.fromName,
        subject: input.subject,
        bodySnippet: input.bodySnippet,
        category: input.category,
        shouldReply: input.shouldReply,
        draftReply: input.draftReply,
        status: input.status,
        skipReason: input.skipReason,
        errorDetail: input.errorDetail,
        inReplyTo: input.inReplyTo,
        emailReferences: input.emailReferences,
        receivedAt: input.receivedAt,
      })
      .returning({ id: emailQueue.id });
    const row = inserted[0];
    return row?.id ?? null;
  } catch (err) {
    // Don't record here — caller decides whether recordError is appropriate
    // based on context (dedupe failure vs insert failure differ).
    console.error(`[poll] insertRow failed for uid=${input.imapUid}:`, (err as Error).message);
    return null;
  }
}

// ---- Batch runner ---------------------------------------------------------

/**
 * Drives a batch of fetched messages through processMessage, returns the
 * highest UID successfully persisted (inserted OR duplicate — both mean
 * the row is in DB, so the cursor can advance). A UID whose row insert
 * failed is NOT in the returned max, so the caller leaves last_uid alone
 * and the next run retries it.
 */
export async function runBatch(
  messages: AsyncIterableIterator<FetchedMessage>,
  client: ImapFlow,
  mailbox: string,
  policy: RoutingPolicy,
  summary: RunSummary,
): Promise<{ highestPersistedUid: number | null }> {
  let highest: number | null = null;

  for await (const msg of messages) {
    const result = await processMessage(msg, client, mailbox, policy, summary);

    if (result.status === 'inserted' || result.status === 'duplicate') {
      // Both mean "the row is in DB"; advance the cursor past them.
      if (highest === null || msg.uid > highest) highest = msg.uid;
    }
    // 'error' -> do not advance; next run retries this UID.
  }

  return { highestPersistedUid: highest };
}

// ---- Sync state helpers ---------------------------------------------------

/**
 * Load last_uid for a mailbox key, or seed with 0 if absent. Returns the
 * current value along with whether a row was pre-existing (caller may want
 * to log "first-run" behavior).
 */
export async function loadSyncState(
  mailbox: string,
): Promise<{ lastUid: number; existed: boolean }> {
  const rows = await db()
    .select()
    .from(emailSyncState)
    .where(eq(emailSyncState.mailbox, mailbox))
    .limit(1);
  const row = rows[0];
  if (row) return { lastUid: row.lastUid ?? 0, existed: true };
  return { lastUid: 0, existed: false };
}

/**
 * Persist last_uid for a mailbox. Upserts (insert ... on conflict update)
 * so the first run that seeds 0 then advances doesn't need a separate
 * insert path.
 */
export async function saveSyncState(mailbox: string, lastUid: number): Promise<void> {
  await db()
    .insert(emailSyncState)
    .values({ mailbox, lastUid })
    .onConflictDoUpdate({
      target: emailSyncState.mailbox,
      set: { lastUid, updatedAt: new Date() },
    });
}

// re-export summary helpers for convenience
export {
  type RunSummary,
  newRunSummary,
  finish,
};