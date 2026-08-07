// scripts/reconcile-seen.ts
//
// One-time cleanup: drain the existing pile of unread mail whose routing
// decision said "should be read" but never got flagged \\Seen because of
// the markSeen deadlock (SPEC §1.2/§1.5). The fix (markSeenBatch) stops
// the pile growing; this script drains what's already there.
//
// Selects email_queue rows where:
//   - status in ('skipped', 'sent', 'rejected')  -- NOT pending/error
//   - the routing decision said "should be read": either a pre-filter
//     match (skip_reason in the pre-filter set) OR category in
//     ('spam', 'other') when the corresponding *_MARK_READ env is true
//   - imap_uid is non-null
// Then intersects with the IMAP UNSEEN set and markSeenBatch's the
// intersection, so we never touch a pending Discord card's unread
// message or an error row that still needs attention.
//
// Guarded like mark-all-read.ts: prints the count and category breakdown,
// requires typed "yes" before flipping anything.
//
//   npm run reconcile:seen
//
// Idempotent: re-running after a successful drain finds nothing to do.

import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { inArray, isNotNull, and, ne } from 'drizzle-orm';
import { getDb } from '../lib/db.js';
import { emailQueue } from '../db/schema.js';
import { withImap, markSeenBatch } from '../lib/imap.js';
import { getEnv } from '../types/env.js';

const MAILBOX = 'INBOX';
const MARK_BATCH = 500;

// skip_reason values produced by the deterministic pre-filters. A row
// with one of these was a pre-filter match and should have been marked
// read at classify time (per AUTOMATED_FORM_MARK_READ / NEWSLETTER_MARK_READ
// / DMARC_MARK_READ).
const PREFILTER_SKIP_REASONS = [
  'recycling_form_make_handled',
  'newsletter',
  'dmarc_report',
];

async function main() {
  const db = getDb();
  const env = getEnv();

  // Build the set of categories that should be marked read under the
  // current env policy. spam/other are gated behind their env flags.
  // Pre-filter rows (matched by skip_reason below) are included
  // unconditionally: the pre-filter records its skip_reason regardless of
  // the matching *_MARK_READ flag, those flags all default true, and the
  // target steady state is that all skipped noise is read.
  const categoryMarkRead = new Set<string>();
  if (env.SPAM_MARK_READ) categoryMarkRead.add('spam');
  if (env.OTHER_MARK_READ) categoryMarkRead.add('other');

  // 1. Pull candidate rows from email_queue. We deliberately EXCLUDE
  //    pending (open Discord cards whose unread state is meaningful) and
  //    error (still needs attention). sent/rejected rows are safe to
  //    mark read — a reply or a manual reject both imply Adam has seen it.
  //
  //    Two conditions make a row "should be read":
  //      (a) skip_reason is one of the pre-filter reasons, OR
  //      (b) category is in the env-gated set (spam/other)
  //    We OR them via two queries and merge, since drizzle's OR across
  //    different columns is cleaner as a union of two where clauses.
  const prefilterRows = await db
    .select({ id: emailQueue.id, imapUid: emailQueue.imapUid, status: emailQueue.status, category: emailQueue.category, skipReason: emailQueue.skipReason, subject: emailQueue.subject })
    .from(emailQueue)
    .where(and(
      isNotNull(emailQueue.imapUid),
      inArray(emailQueue.status, ['skipped', 'sent', 'rejected']),
      inArray(emailQueue.skipReason, PREFILTER_SKIP_REASONS),
    ));

  let categoryRows: { id: string; imapUid: number | null; status: string | null; category: string | null; skipReason: string | null; subject: string | null }[] = [];
  if (categoryMarkRead.size > 0) {
    categoryRows = await db
      .select({ id: emailQueue.id, imapUid: emailQueue.imapUid, status: emailQueue.status, category: emailQueue.category, skipReason: emailQueue.skipReason, subject: emailQueue.subject })
      .from(emailQueue)
      .where(and(
        isNotNull(emailQueue.imapUid),
        inArray(emailQueue.status, ['skipped', 'sent', 'rejected']),
        inArray(emailQueue.category, [...categoryMarkRead]),
        // Avoid double-counting rows already pulled by the pre-filter query.
        ne(emailQueue.skipReason, 'recycling_form_make_handled'),
        ne(emailQueue.skipReason, 'newsletter'),
        ne(emailQueue.skipReason, 'dmarc_report'),
      ));
  }

  // Merge + dedupe by id, then by uid.
  const byId = new Map<string, { id: string; imapUid: number; category: string | null; skipReason: string | null; subject: string | null }>();
  for (const r of [...prefilterRows, ...categoryRows]) {
    if (r.imapUid === null) continue;
    if (!byId.has(r.id)) {
      byId.set(r.id, {
        id: r.id,
        imapUid: r.imapUid,
        category: r.category,
        skipReason: r.skipReason,
        subject: r.subject,
      });
    }
  }
  const candidates = [...byId.values()];

  if (candidates.length === 0) {
    console.log('No rows in email_queue match the "should be read" criteria. Nothing to do.');
    return;
  }

  // 2. Breakdown for the confirmation prompt.
  const byCategory: Record<string, number> = {};
  const bySkipReason: Record<string, number> = {};
  for (const r of candidates) {
    const c = r.category ?? '(null)';
    byCategory[c] = (byCategory[c] ?? 0) + 1;
    const s = r.skipReason ?? '(null)';
    bySkipReason[s] = (bySkipReason[s] ?? 0) + 1;
  }
  console.log(`Found ${candidates.length} row(s) in email_queue whose routing decision said "should be read".`);
  console.log('  by category:', JSON.stringify(byCategory));
  console.log('  by skip_reason:', JSON.stringify(bySkipReason));

  // 3. Intersect with the IMAP UNSEEN set. A row whose imap_uid is
  //    already read is a no-op for markSeenBatch; filtering them out
  //    keeps the confirmation count honest.
  console.log(`\nFetching current UNSEEN set from ${MAILBOX}...`);
  const unseenUids = await withImap(async (client) => {
    const lock = await client.getMailboxLock(MAILBOX, { readOnly: true, acquireTimeout: 15_000 });
    try {
      const uids = await client.search({ seen: false }, { uid: true });
      return new Set<number>(Array.isArray(uids) ? uids : []);
    } finally {
      lock.release();
    }
  });

  const toMark = candidates.filter((r) => unseenUids.has(r.imapUid));
  const alreadyRead = candidates.length - toMark.length;
  console.log(`  ${toMark.length} are currently UNSEEN in IMAP (will be marked read).`);
  console.log(`  ${alreadyRead} are already read (no-op, skipped).`);

  if (toMark.length === 0) {
    console.log('\nNothing to do — every candidate is already read.');
    return;
  }

  // 4. Confirmation guard.
  const rl = createInterface({ input, output });
  const answer = (
    await rl.question(`\nMark ${toMark.length} message(s) as read in ${MAILBOX}? Type "yes" to proceed: `)
  ).trim().toLowerCase();
  rl.close();
  if (answer !== 'yes') {
    console.log('aborted');
    return;
  }

  // 5. markSeenBatch in chunks. pending/error rows were excluded by the
  //    query, so this cannot touch an open Discord card's unread message.
  const uidsToMark = toMark.map((r) => r.imapUid);
  let flipped = 0;
  await withImap(async (client) => {
    for (let i = 0; i < uidsToMark.length; i += MARK_BATCH) {
      const batch = uidsToMark.slice(i, i + MARK_BATCH);
      await markSeenBatch(client, MAILBOX, batch);
      flipped += batch.length;
      console.log(`  marked ${batch.length} read (total ${flipped}/${uidsToMark.length})`);
    }
  });

  console.log(`\nDone. marked ${flipped} message(s) as read in ${MAILBOX}.`);
  console.log('Pending and error rows were NOT touched — open Discord cards stay unread.');
}

main().catch((err) => {
  console.error('reconcile-seen crashed:', err);
  process.exit(1);
});