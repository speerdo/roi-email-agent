// scripts/backfill-reply-to.ts
//
// One-off backfill: re-fetch the Reply-To header for every email_queue row
// that has an imap_uid and a null reply_to column, and persist it so
// lib/mail/recipient.ts can route future replies to the real submitter
// instead of notify@web3forms.com.
//
// Then prints a report of the rows whose APPROVED reply was sent to the
// wrong address (From instead of Reply-To) so Adam can decide who to
// re-contact by hand. Per spec §2.2 / §6 Q3: re-send the existing drafts
// to the correct addresses after Adam eyeballs the list.
//
// Safe to re-run: only touches rows where reply_to IS NULL, and only
// updates when a Reply-To header is actually present on the message.
// Leaves rows with no Reply-To header null (correct — replyRecipient
// falls back to From for those).
//
//   npm run backfill:reply-to
//
// Or add to package.json if it becomes a keep-around utility.

import 'dotenv/config';
import { simpleParser } from 'mailparser';
import { eq, and, isNull, isNotNull, ne, inArray } from 'drizzle-orm';
import { getDb } from '../lib/db.js';
import { emailQueue } from '../db/schema.js';
import { connectImap } from '../lib/imap.js';

const MAILBOX = 'INBOX';
const FETCH_QUERY = { uid: true, source: true } as const;
// Batch the IMAP fetch range to keep response sizes sane. 200 UIDs per
// round-trip is well under any per-command cap and keeps memory flat.
const FETCH_BATCH = 200;

async function main() {
  const db = getDb();

  // 1. Find every row with an imap_uid and no reply_to yet. We only need
  //    to re-fetch messages where Reply-To might exist; sent/skipped/error
  //    rows all qualify (the column was added after they were inserted).
  const candidates = await db
    .select({
      id: emailQueue.id,
      imapUid: emailQueue.imapUid,
      fromAddr: emailQueue.fromAddr,
      status: emailQueue.status,
      category: emailQueue.category,
    })
    .from(emailQueue)
    .where(and(isNull(emailQueue.replyTo), isNotNull(emailQueue.imapUid)));

  console.log(`Found ${candidates.length} row(s) with null reply_to and a non-null imap_uid.`);

  if (candidates.length === 0) {
    await reportMistargetedReplies(db);
    return;
  }

  // 2. Connect once, fetch each message's source by UID, parse out
  //    Reply-To, persist non-null values back to the row.
  const client = connectImap();
  try {
    await client.connect();
    // acquireTimeout for consistency with lib/imap.ts: nothing nests a
    // lock in this script, but a hang here should fail loudly rather than
    // wait out the socket timeout.
    const lock = await client.getMailboxLock(MAILBOX, { readOnly: true, acquireTimeout: 15_000 });
    try {
      let updated = 0;
      let noReplyTo = 0;
      let missing = 0;

      for (let i = 0; i < candidates.length; i += FETCH_BATCH) {
        const batch = candidates.slice(i, i + FETCH_BATCH);
        const uids = batch
          .map((r) => r.imapUid)
          .filter((u): u is number => u !== null);
        if (uids.length === 0) continue;
        const range = uids.join(',');

        // Fetch all messages in the batch in one pass. ImapFlow yields
        // objects in UID order; we then match them back to candidate rows.
        const byUid = new Map<number, { id: string; fromAddr: string }>();
        for (const r of batch) {
          if (r.imapUid !== null) byUid.set(r.imapUid, { id: r.id, fromAddr: r.fromAddr });
        }

        for await (const raw of client.fetch(range, FETCH_QUERY, { uid: true })) {
          const meta = byUid.get(raw.uid);
          if (!meta) continue;
          if (!raw.source) { missing++; continue; }
          const parsed = await simpleParser(raw.source);
          const replyToValue = parsed.replyTo?.value?.[0]?.address;
          if (typeof replyToValue === 'string' && replyToValue.length > 0) {
            await db
              .update(emailQueue)
              .set({ replyTo: replyToValue, updatedAt: new Date() })
              .where(and(eq(emailQueue.id, meta.id), isNull(emailQueue.replyTo)));
            updated++;
            console.log(`  uid=${raw.uid} row=${meta.id} reply_to=${replyToValue}`);
          } else {
            noReplyTo++;
          }
        }
      }

      console.log(
        `\nBackfill complete. updated=${updated} no_reply_to=${noReplyTo} missing_source=${missing}`,
      );
    } finally {
      lock.release();
    }
  } finally {
    try { await client.logout(); } catch { client.close(); }
  }

  // 3. Report: which already-sent rows had their reply mailed to the wrong
  //    address? Those are the rows Adam needs to re-contact by hand.
  await reportMistargetedReplies(db);
}

/**
 * Print the rows whose approved reply went to From instead of Reply-To.
 * Per spec §2.2 these are the `sent` rows where fromAddr is an automated
 * sender (notify@web3forms.com is the canonical case) but reply_to now
 * holds a real human address. The drafts are already on the row; Adam
 * decides who to re-send to.
 *
 * Also flags pending rows in the same shape — those would mis-send TODAY
 * if approved before this backfill ran, so they're an even higher
 * priority to surface.
 */
async function reportMistargetedReplies(db: ReturnType<typeof getDb>): Promise<void> {
  // A row "went to the wrong address" when:
  //   - status in ('sent', 'rejected', 'pending')  (a reply was or will be sent)
  //   - reply_to is non-null and differs from from_addr
  //   - from_addr is not the human (i.e. reply_to is the human)
  // The simplest reliable signal: reply_to is non-null AND reply_to != from_addr.
  // That captures both Web3Forms submissions and any other Reply-To rerouting.
  const rows = await db
    .select({
      id: emailQueue.id,
      status: emailQueue.status,
      category: emailQueue.category,
      fromAddr: emailQueue.fromAddr,
      replyTo: emailQueue.replyTo,
      subject: emailQueue.subject,
      receivedAt: emailQueue.receivedAt,
      draftReply: emailQueue.draftReply,
    })
    .from(emailQueue)
    .where(and(
      isNotNull(emailQueue.replyTo),
      ne(emailQueue.replyTo, emailQueue.fromAddr),
      inArray(emailQueue.status, ['sent', 'pending', 'rejected', 'error']),
    ));

  const sent = rows.filter((r) => r.status === 'sent');
  const pending = rows.filter((r) => r.status === 'pending');

  console.log('\n=== Mistargeted reply report ===');
  console.log(`sent rows that went to the wrong address: ${sent.length}`);
  for (const r of sent) {
    console.log(
      `  [sent] id=${r.id} received=${r.receivedAt?.toISOString() ?? '?'}\n` +
      `    from=${r.fromAddr}  replyTo=${r.replyTo}\n` +
      `    subject="${r.subject ?? '(no subject)'}"\n` +
      `    draft_excerpt="${(r.draftReply ?? '').slice(0, 120)}"`,
    );
  }
  console.log(`\npending rows that WOULD mis-send if approved today: ${pending.length}`);
  for (const r of pending) {
    console.log(
      `  [pending] id=${r.id} from=${r.fromAddr} replyTo=${r.replyTo}\n` +
      `    subject="${r.subject ?? '(no subject)'}"`,
    );
  }

  if (sent.length > 0) {
    console.log(
      '\nNEXT STEP: review the sent rows above. To re-send a draft to the',
    );
    console.log(
      'correct address, Adam can either Approve a fresh card (after running',
    );
    console.log(
      '`npm run refresh:cards`) or send the draft_reply from the row directly.',
    );
  }
}

// isNotNull is exported from drizzle-orm; imported at the top of the file
// alongside the other drizzle helpers used in the candidate + report queries.

main().catch((err) => {
  console.error('backfill-reply-to crashed:', err);
  process.exit(1);
});