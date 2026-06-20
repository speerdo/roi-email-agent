// scripts/backfill-cards.ts
//
// One-off backfill: posts Discord cards for `pending` email_queue rows that
// never got one. These are rows inserted by Phase 5 poller runs before
// Phase 6's card-posting existed — the poller dedupes by message_id before
// it ever reaches the routing/card step, so it will never revisit them.
//
// Guarded like scripts/test-smtp.ts: lists what it's about to do and
// requires an explicit "yes" before posting anything (this sends real
// messages to the configured Discord channel).
//
//   npm run backfill:cards

import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { and, eq, isNull } from 'drizzle-orm';
import { getDb } from '../lib/db.js';
import { emailQueue } from '../db/schema.js';
import { postCard } from '../lib/discord/rest.js';

async function main() {
  const db = getDb();
  const rows = await db
    .select({
      id: emailQueue.id,
      fromAddr: emailQueue.fromAddr,
      fromName: emailQueue.fromName,
      subject: emailQueue.subject,
      category: emailQueue.category,
      draftReply: emailQueue.draftReply,
      receivedAt: emailQueue.receivedAt,
    })
    .from(emailQueue)
    .where(and(eq(emailQueue.status, 'pending'), isNull(emailQueue.discordMessageId)));

  if (rows.length === 0) {
    console.log('No pending rows missing a Discord card. Nothing to do.');
    return;
  }

  console.log(`Found ${rows.length} pending row(s) with no Discord card:\n`);
  for (const r of rows) {
    console.log(`  ${r.id}  [${r.category ?? 'other'}]  ${r.fromAddr}  "${r.subject ?? '(no subject)'}"`);
  }

  const rl = createInterface({ input, output });
  const answer = (
    await rl.question(`\nPost a Discord card for each of the ${rows.length} row(s) above? Type "yes" to proceed: `)
  ).trim().toLowerCase();
  rl.close();
  if (answer !== 'yes') {
    console.log('aborted');
    return;
  }

  let posted = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      const result = await postCard({
        id: r.id,
        fromAddr: r.fromAddr,
        fromName: r.fromName,
        subject: r.subject,
        category: r.category,
        draftReply: r.draftReply,
        receivedAt: r.receivedAt,
      });
      await db
        .update(emailQueue)
        .set({ discordMessageId: result.messageId, updatedAt: new Date() })
        .where(eq(emailQueue.id, r.id));
      console.log(`  posted: ${r.id} -> discord message ${result.messageId}`);
      posted++;
    } catch (err) {
      const e = err as Error;
      console.error(`  FAILED: ${r.id} (${r.subject ?? 'no subject'}): ${e.message}`);
      failed++;
    }
    // Discord's per-channel rate limit is tight enough that posting several
    // cards back-to-back can 429 (observed live: 2 of 9 failed without this).
    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  console.log(`\nDone. posted=${posted} failed=${failed}`);
}

main().catch((err) => {
  console.error('backfill-cards crashed:', err);
  process.exit(1);
});
