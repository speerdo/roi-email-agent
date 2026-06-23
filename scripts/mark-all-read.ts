// scripts/mark-all-read.ts
//
// Bulk-marks every message in the INBOX as \\Seen via IMAP. Useful after
// the poller has classified/inserted a backlog so the webmail inbox isn't
// left showing hundreds of unread messages that have already been triaged.
//
// This does NOT delete anything — messages stay in the inbox, just marked
// read. The poller's peek-based fetch is unaffected (peek never sets
// \\Seen regardless of prior state); this only flips the visibility flag
// in webmail/clients.
//
// Guarded: prints the count of unread messages it found and requires an
// explicit "yes" before flipping anything. Paged (500/search batch) so
// it doesn't choke on a huge mailbox.
//
//   npm run mark:read

import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { withImap } from '../lib/imap.js';

const MAILBOX = 'INBOX';
const SEARCH_BATCH = 500;

async function main() {
  // First pass: count unread so we can report what's about to be flipped.
  console.log(`Counting unread messages in ${MAILBOX}...`);
  const unreadCount = await withImap(async (client) => {
    const lock = await client.getMailboxLock(MAILBOX, { readOnly: true });
    try {
      const uids = await client.search({ seen: false }, { uid: true });
      return Array.isArray(uids) ? uids.length : 0;
    } finally {
      lock.release();
    }
  });

  if (unreadCount === 0) {
    console.log('No unread messages. Nothing to do.');
    return;
  }

  console.log(`Found ${unreadCount} unread message(s) in ${MAILBOX}.\n`);
  const rl = createInterface({ input, output });
  const answer = (
    await rl.question(`Mark all ${unreadCount} message(s) as read? Type "yes" to proceed: `)
  ).trim().toLowerCase();
  rl.close();
  if (answer !== 'yes') {
    console.log('aborted');
    return;
  }

  // Second pass: page through unread UIDs in SEARCH_BATCH-sized chunks and
  // flip \\Seen on each batch in one messageFlagsAdd call. One IMAP
  // command per 500 messages is far cheaper than one per message and
  // stays well under any per-command timeout.
  let flipped = 0;
  let batchNo = 0;
  await withImap(async (client) => {
    const lock = await client.getMailboxLock(MAILBOX, { readOnly: false });
    try {
      const allUids = (await client.search({ seen: false }, { uid: true })) as number[];
      if (!Array.isArray(allUids) || allUids.length === 0) {
        console.log('No unread messages after recount. Nothing to do.');
        return;
      }

      for (let i = 0; i < allUids.length; i += SEARCH_BATCH) {
        batchNo++;
        const batch = allUids.slice(i, i + SEARCH_BATCH);
        const range = batch.join(',');
        await client.messageFlagsAdd(range, ['\\Seen'], { uid: true });
        flipped += batch.length;
        console.log(`  batch ${batchNo}: marked ${batch.length} read (total ${flipped}/${allUids.length})`);
      }
    } finally {
      lock.release();
    }
  });

  console.log(`\nDone. marked ${flipped} message(s) as read in ${MAILBOX}.`);
}

main().catch((err) => {
  console.error('mark-all-read crashed:', err);
  process.exit(1);
});