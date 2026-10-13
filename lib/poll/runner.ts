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
import { and, eq } from 'drizzle-orm';
import { getDb } from '../db.js';
import { emailQueue, emailSyncState, newsletterSubscribers } from '../../db/schema.js';
import { cleanBody } from '../mail/clean.js';
import { runPrefilters } from '../mail/prefilter.js';
import { classifyAndDraft, type ClassifyResult } from '../gemini/index.js';
import { parseNewsletterSignup } from '../mail/newsletter.js';
import { postPlainMessage } from '../discord/rest.js';
import { requireBrandEnv } from '../brands/env.js';
import { DEFAULT_BRAND, type BrandProfile } from '../brands/index.js';
import { getEnv } from '../env.js';
import { resolveCityPage } from '../site/resolveCityPage.js';
import { renderRecyclingHelp, greetingName } from '../mail/templates/recyclingHelp.js';
import { stripDraftSignoff } from '../mail/signature.js';
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
  /** Full row fields needed to build a Discord card. Available since Phase 6. */
  fromAddr: string;
  fromName: string | undefined;
  replyTo: string | undefined;
  subject: string | undefined;
  receivedAt: Date;
  /** Cleaned original-email snippet, shown on the card alongside the draft. */
  bodySnippet: string;
  /** Human-readable routing hint for recycling_help (e.g.
   *  "Greencastle, PA -> /states/pennsylvania/greencastle"). Empty for
   *  non-recycling_help categories. Shown on the card so a reviewer can
   *  catch a bad city resolution BEFORE approving. */
  routing: string;
}

/**
 * Optional side-effect callback the runner invokes when the policy decides
 * `cardAction === 'post'`. Phase 5 passed `undefined` (runner logged only);
 * Phase 6 passes a real `postCard` wrapper that records discord_message_id
 * back onto the row.
 */
export type CardPoster = (ctx: RoutingContext, rowId: string) => Promise<void>;

export type RoutingPolicy = (ctx: RoutingContext) => RoutingDecision;

/**
 * Phase 5 incremental policy. Reply-worthy non-spam -> pending + would-post
 * card log; spam -> skipped + markRead per SPAM_MARK_READ (default true so
 * the inbox unread badge reflects only open work); everything else ->
 * skipped, markRead per OTHER_MARK_READ, no card. Cards themselves are
 * wired in Phase 6.
 *
 * Steady-state target (SPEC §1.4): unread count == open Discord cards +
 * error rows. Setting SPAM_MARK_READ=false or OTHER_MARK_READ=false
 * reintroduces a "safety net" of visible unread in webmail at the cost of
 * a noisy unread badge.
 */
export const incrementalPolicy: RoutingPolicy = (ctx) => {
  const env = getEnv();
  if (ctx.shouldReply && ctx.category !== 'spam') {
    return { status: 'pending', markRead: false, cardAction: 'post' };
  }
  if (ctx.category === 'spam') {
    return {
      status: 'skipped',
      markRead: env.SPAM_MARK_READ,
      cardAction: 'skip',
      skipReason: 'spam',
    };
  }
  return {
    status: 'skipped',
    markRead: env.OTHER_MARK_READ,
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
  /** True when the routing decision / pre-filter said to mark this
   *  message \\Seen. The runner collects these UIDs and the caller
   *  flushes them via markSeenBatch AFTER the fetch generator completes
   *  and the read-only mailbox lock is released. Never call markSeen
   *  inline from processMessage — that nests locks on the same client
   *  and deadlocks (see lib/imap.ts markSeen doc + SPEC §1.2). */
  markRead?: boolean;
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
 * Note on `client`: an open ImapFlow connection. We DO NOT acquire any
 * mailbox lock in this module — the caller (api/poll.ts) owns the fetch
 * generator whose read-only lock is held for the lifetime of the loop.
 * processMessage must never call markSeen/markSeenBatch on `client`
 * directly: doing so nests a write lock inside the fetch lock on the
 * same connection and deadlocks (ImapFlow locks are a strict
 * per-connection mutex — see lib/imap.ts markSeen doc + SPEC §1.2).
 * Instead we return `markRead` on ProcessMessageResult and let
 * runBatch's caller flush via markSeenBatch after the generator exhausts.
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
  cardPoster?: CardPoster,
  brand: BrandProfile = DEFAULT_BRAND,
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

  // 1b. Unparseable message (SPEC §3.5). The fetch generator yields a
  // degraded FetchedMessage with parseError set rather than throwing,
  // because a throw from inside the generator escapes runBatch's
  // for-await entirely (its try/catch only wraps processMessage) and
  // leaves no row — which pins the cursor and stalls every later poll on
  // the same message. Record an error row so the cursor CAN advance;
  // scripts/retry-errors.ts can pick it up later.
  if (msg.parseError) {
    const rowId = await insertRow({
      messageId,
      imapUid: msg.uid,
      fromAddr: msg.fromAddr || '(unparseable)',
      fromName: msg.fromName,
      replyTo: msg.replyTo,
      subject: msg.subject,
      bodySnippet: '(unparseable message)',
      category: null,
      shouldReply: false,
      draftReply: null,
      status: 'error',
      skipReason: null,
      errorDetail: `parse failed: ${msg.parseError}`,
      receivedAt: msg.receivedAt,
    });
    recordError(summary, {
      uid: msg.uid,
      messageId,
      stage: 'parse',
      message: msg.parseError,
    });
    bumpStatus(summary, 'error');
    // 'inserted' (not 'error') on purpose: the row is in the DB, so the
    // cursor may advance past this UID. Returning 'error' here would
    // recreate the head-of-line block this branch exists to prevent.
    return rowId === null
      ? { status: 'error', uid: msg.uid }
      : { status: 'inserted', uid: msg.uid, rowId, shouldReply: false, markRead: false };
  }

  // 2. Pre-filters (deterministic, no LLM call).
  const pre = runPrefilters({
    subject: msg.subject ?? '',
    from: { address: msg.fromAddr, name: msg.fromName },
    contentType: msg.contentType,
  }, brand);

  if (pre.matched) {
    // DowntownDry newsletter signups: skip + mark read like any pre-filter
    // hit, but ALSO capture the subscriber (upsert; announce only on first
    // sighting). Capture failure must NOT lose the skip — it's logged and
    // the row still lands.
    if (pre.category === 'newsletter' && brand.newsletterSubscribers) {
      await captureNewsletterSubscriber(brand, msg, summary);
    }

    const rowId = await insertRow({
      messageId,
      imapUid: msg.uid,
      fromAddr: msg.fromAddr,
      fromName: msg.fromName,
      replyTo: msg.replyTo,
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
      brand,
    });

    if (rowId === null) {
      return { status: 'error', uid: msg.uid };
    }

    bumpCategory(summary, pre.category);
    bumpSkipReason(summary, pre.skipReason);
    bumpStatus(summary, 'skipped');

    // NOTE: do NOT call markSeen here. The fetch generator still holds
    // the read-only mailbox lock on this client; a nested write lock
    // deadlocks (see lib/imap.ts markSeen doc). Return the flag and let
    // runBatch's caller flush via markSeenBatch after the generator
    // completes.
    return {
      status: 'inserted',
      uid: msg.uid,
      rowId,
      category: pre.category,
      shouldReply: false,
      markRead: pre.markRead,
    };
  }

  // SPEC §3.11 filter-drift detection (ROI only): a Web3Forms message whose
  // subject looks like a recycling request did NOT match the recycling
  // pre-filter. Usually means the form's subject template changed and 300+
  // form submissions/yr are about to start hitting Gemini + generating
  // cards. Scope to "subject looks like a recycling request" so the
  // legitimate contact-form mail doesn't trip the warning. Sender check
  // matches the @web3forms.com DOMAIN, not the notify@ local part —
  // Web3Forms plus-addresses per form key
  // (e.g. notify+kjvf7p@web3forms.com for DD).
  if (
    brand.id === DEFAULT_BRAND.id &&
    /@web3forms\.com/i.test(msg.fromAddr) &&
    /^recycling request from/i.test(msg.subject ?? '')
  ) {
    const drift = `filter drift: uid=${msg.uid} from web3forms with recycling-shaped subject "${(msg.subject ?? '').slice(0, 80)}" did NOT match the recycling pre-filter — check AUTOMATED_FORM_SUBJECTS`;
    summary.filterDriftWarnings.push(drift);
    console.warn(`[poll] ${drift}`);
  }

  // 3. Gemini classify + draft.
  let classify: ClassifyResult;
  try {
    classify = await classifyAndDraft({
      from: msg.fromAddr,
      subject: msg.subject ?? '',
      snippet,
    }, brand);
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
      replyTo: msg.replyTo,
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
  //
  // recycling_help override (SPEC §2.5-2.7, ROI only): the LLM is barred
  // from emitting a recycleoldtech.com URL for this category (a
  // hallucinated path 404s and the lead is dead). It outputs structured
  // location fields; code resolves the URL deterministically from the site
  // index and composes the reply from a fixed template. The model's draft
  // is discarded; the routing label is persisted for the card + audit.
  // The branch cannot fire for DD anyway — recycling_help is not in DD's
  // category set, so parseClassifyResult maps it to 'other'.
  let draftReply = classify.draft_reply || null;
  let routingLabel = '';
  let locationHint: unknown = null;
  let resolvedCityUrl: string | null = null;
  if (classify.category === 'recycling_help' && classify.should_reply) {
    const resolved = resolveCityPage(classify.location ?? null);
    draftReply = renderRecyclingHelp({
      // Prefer the name stated in the body over the From display name:
      // Web3Forms sends `From: "Notifications" <notify@web3forms.com>`, so
      // the header alone would greet the sender as "Hi Notifications".
      firstName: greetingName(classify.sender_name, msg.fromName),
      resolved,
      location: classify.location ?? null,
    });
    routingLabel = resolved.routingLabel;
    locationHint = classify.location ?? null;
    resolvedCityUrl = resolved.url;
  }

  // Strip the sign-off ONCE, here, before the draft is stored. The Discord
  // card, the edit modal and the outbound email all read this stored row,
  // so stripping only at send time (as we did originally) left the card
  // showing a "RecycleOldTech / Adam" the recipient never actually got.
  // The branded signature block in lib/mail/signature.ts carries the name.
  // A draft that is nothing BUT a sign-off is kept as-is rather than
  // stored empty, which the approve path would refuse to send.
  if (draftReply) {
    const stripped = stripDraftSignoff(draftReply);
    draftReply = stripped.trim() === '' ? draftReply : stripped;
  }

  const rowId = await insertRow({
    messageId,
    imapUid: msg.uid,
    fromAddr: msg.fromAddr,
    fromName: msg.fromName,
    replyTo: msg.replyTo,
    subject: msg.subject,
    bodySnippet: snippet,
    category: classify.category,
    shouldReply: classify.should_reply,
    draftReply,
    status: 'pending',
    skipReason: null,
    inReplyTo: msg.inReplyTo,
    emailReferences: msg.references,
    receivedAt: msg.receivedAt,
    locationHint,
    resolvedCityUrl,
    routingLabel: routingLabel || null,
    brand,
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
    draftReply: draftReply ?? '',
    fromAddr: msg.fromAddr,
    fromName: msg.fromName,
    replyTo: msg.replyTo,
    subject: msg.subject,
    receivedAt: msg.receivedAt,
    bodySnippet: snippet,
    routing: routingLabel,
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
    if (cardPoster) {
      try {
        await cardPoster(
          {
            rowId,
            imapUid: msg.uid,
            category: classify.category,
            shouldReply: classify.should_reply,
            draftReply: draftReply ?? '',
            fromAddr: msg.fromAddr,
            fromName: msg.fromName,
            replyTo: msg.replyTo,
            subject: msg.subject,
            receivedAt: msg.receivedAt,
            bodySnippet: snippet,
            routing: routingLabel,
          },
          rowId,
        );
      } catch (err) {
        const e = err as Error;
        recordError(summary, {
          uid: msg.uid,
          messageId,
          stage: 'postCard',
          message: e.message,
        });
      }
    } else {
      console.log(
        `[poll] would post card for row=${rowId} uid=${msg.uid} category=${classify.category}`,
      );
    }
  }

  if (decision.markRead) {
    // NOTE: deferred to runBatch's caller (api/poll.ts). Calling markSeen
    // here would nest a write lock inside the fetch generator's read-only
    // lock on the same client and deadlock — see lib/imap.ts markSeen doc
    // and SPEC §1.2. We just record the flag; the caller batches all
    // markRead UIDs into one markSeenBatch call after the generator is
    // exhausted.
  }

  return {
    status: 'inserted',
    uid: msg.uid,
    rowId,
    category: classify.category,
    shouldReply: classify.should_reply,
    markRead: decision.markRead,
  };
}

// ---- Newsletter capture (brand.newsletterSubscribers) ---------------------

/**
 * Upsert a newsletter subscriber for a brand and announce the FIRST
 * sighting to the brand's Discord channel as a plain one-line message:
 * `📬 New newsletter subscriber: <email> (<Page>)`. A repeat signup
 * (same brand + email) updates last_seen_at and is NOT re-announced.
 *
 * Best-effort: a DB or Discord failure logs against the summary but never
 * loses the underlying skip/mark-read handling of the message itself.
 */
async function captureNewsletterSubscriber(
  brand: BrandProfile,
  msg: FetchedMessage,
  summary: RunSummary,
): Promise<void> {
  const signup = parseNewsletterSignup(msg.textSnippet || msg.text, msg.subject ?? '');
  if (!signup) {
    const warn = `newsletter pre-filter matched but no parsable signup (uid=${msg.uid}, subject="${(msg.subject ?? '').slice(0, 80)}")`;
    summary.filterDriftWarnings.push(warn);
    console.warn(`[poll] ${warn}`);
    return;
  }

  try {
    // Race-safe upsert: insert first with ON CONFLICT DO NOTHING. Two
    // overlapping ticks can't both win the unique (brand, email) index —
    // exactly one insert returns a row. An empty returning() means a
    // repeat signup: refresh last_seen_at, do NOT re-announce.
    const inserted = await db()
      .insert(newsletterSubscribers)
      .values({
        brand: brand.id,
        email: signup.email,
        sourcePage: signup.sourcePage,
      })
      .onConflictDoNothing()
      .returning({ id: newsletterSubscribers.id });

    if (inserted.length === 0) {
      await db()
        .update(newsletterSubscribers)
        .set({ lastSeenAt: new Date(), sourcePage: signup.sourcePage })
        .where(
          and(
            eq(newsletterSubscribers.brand, brand.id),
            eq(newsletterSubscribers.email, signup.email),
          ),
        );
      return; // Repeat signup: refresh, do not re-announce.
    }
  } catch (err) {
    const e = err as Error;
    console.error(`[poll] newsletter upsert failed (uid=${msg.uid}):`, e.message);
    recordError(summary, {
      uid: msg.uid,
      stage: 'newsletter-upsert',
      message: e.message,
    });
    return; // Don't announce a signup we failed to persist.
  }

  // First sighting: announce. Best-effort — a Discord outage must not
  // fail the poll tick.
  try {
    const { discordChannelId } = requireBrandEnv(brand);
    const page = signup.sourcePage ? ` (${signup.sourcePage})` : '';
    await postPlainMessage(
      discordChannelId,
      `📬 New newsletter subscriber: ${signup.email}${page}`,
    );
  } catch (err) {
    const e = err as Error;
    console.warn(`[poll] newsletter announce failed (uid=${msg.uid}):`, e.message);
    recordError(summary, {
      uid: msg.uid,
      stage: 'newsletter-announce',
      message: e.message,
    });
  }
}

// ---- Row insert helper ----------------------------------------------------

interface InsertRowInput {
  messageId: string;
  imapUid: number;
  fromAddr: string;
  fromName?: string;
  replyTo?: string;
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
  /** recycling_help audit trail (SPEC §2.7). Null for non-recycling_help. */
  locationHint?: unknown;
  resolvedCityUrl?: string | null;
  routingLabel?: string | null;
  /** Owning brand. Optional at the type level so error-path callers can
   *  omit it; inserts without it land as 'roi' (the column default). */
  brand?: BrandProfile;
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
        brand: input.brand?.id ?? 'roi',
        imapUid: input.imapUid,
        fromAddr: input.fromAddr,
        fromName: input.fromName,
        replyTo: input.replyTo,
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
        locationHint: input.locationHint === undefined ? null : input.locationHint,
        resolvedCityUrl: input.resolvedCityUrl ?? null,
        routingLabel: input.routingLabel ?? null,
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
 * the row is in DB, so the cursor can advance) plus the UIDs that should
 * be flagged \\Seen. A UID whose row insert failed is NOT in the returned
 * max, so the caller leaves last_uid alone and the next run retries it.
 *
 * `summary.highestPersistedUid` is updated on every iteration (not just at
 * the end) so a caller can still read out partial progress even if this
 * loop throws partway through (e.g. the IMAP connection dies on message 20
 * of 25) — the thrown exception propagates past this function's own
 * `return`, but the mutation already happened on the shared `summary`.
 *
 * The returned `seenUids` MUST be flushed via markSeenBatch AFTER the
 * fetch generator has been fully consumed (i.e. after this function
 * returns, when the read-only mailbox lock has been released). Calling
 * markSeen/markSeenBatch on `client` while the generator's lock is still
 * held deadlocks — see lib/imap.ts markSeen doc.
 */
export async function runBatch(
  messages: AsyncIterableIterator<FetchedMessage>,
  client: ImapFlow,
  mailbox: string,
  policy: RoutingPolicy,
  summary: RunSummary,
  cardPoster?: CardPoster,
  brand: BrandProfile = DEFAULT_BRAND,
): Promise<{ highestPersistedUid: number | null; seenUids: number[] }> {
  const seenUids: number[] = [];
  for await (const msg of messages) {
    let result: ProcessMessageResult;
    try {
      result = await processMessage(msg, client, mailbox, policy, summary, cardPoster, brand);
    } catch (err) {
      // Poison-message guard (SPEC §3.5), second layer. Parse failures are
      // already handled upstream (lib/imap.ts yields a degraded message
      // with parseError set, and processMessage writes an error row for
      // it), so what reaches here is an unexpected throw from anywhere
      // else in processMessage. Left unguarded it escapes the for-await,
      // leaving no row for that UID: the cursor never advances past it, so
      // every subsequent poll re-fetches the same message, throws again,
      // and processes NOTHING — a permanent head-of-line block with no
      // alert. Insert a minimal error row keyed on no-message-id:<uid> so
      // the cursor CAN advance and the message is auditable in Neon.
      const e = err as Error;
      recordError(summary, {
        uid: msg.uid,
        stage: 'processMessage',
        message: `unhandled throw: ${e.message}`,
      });
      try {
        await insertRow({
          messageId: `no-message-id:${msg.uid}`,
          imapUid: msg.uid,
          fromAddr: msg.fromAddr ?? '(unknown)',
          fromName: msg.fromName,
          replyTo: msg.replyTo,
          subject: msg.subject,
          bodySnippet: '(unparseable message)',
          category: null,
          shouldReply: false,
          draftReply: null,
          status: 'error',
          skipReason: null,
          errorDetail: `unhandled throw in processMessage: ${e.message}`,
          inReplyTo: msg.inReplyTo,
          emailReferences: msg.references,
          receivedAt: msg.receivedAt,
        });
        bumpStatus(summary, 'error');
        // 'inserted', not 'error': the row landed, so the cursor may move
        // past this UID. Reporting 'error' here would hold the cursor and
        // recreate the exact head-of-line block this guard exists to
        // prevent.
        result = { status: 'inserted', uid: msg.uid, markRead: false };
      } catch (insertErr) {
        // Last-resort: if even the error-row insert fails, record and
        // treat as 'error' so we DO NOT advance the cursor (the message
        // is genuinely unhandleable and re-fetching it is the only
        // chance someone notices). This is the one case where a poison
        // message can still block; the Phase 9 error alert surfaces it.
        const ie = insertErr as Error;
        recordError(summary, {
          uid: msg.uid,
          stage: 'processMessage-error-insert',
          message: ie.message,
        });
        result = { status: 'error', uid: msg.uid };
      }
    }

    if (result.status === 'inserted' || result.status === 'duplicate') {
      // Both mean "the row is in DB"; advance the cursor past them. An
      // error row written by the poison guards above also reports
      // 'inserted' for exactly this reason (see §3.5).
      if (summary.highestPersistedUid === null || msg.uid > summary.highestPersistedUid) {
        summary.highestPersistedUid = msg.uid;
      }
    }
    // 'error' without a row -> do not advance; next run retries this UID.

    if (result.markRead === true && result.status !== 'error') {
      seenUids.push(msg.uid);
    }
  }

  return { highestPersistedUid: summary.highestPersistedUid, seenUids };
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