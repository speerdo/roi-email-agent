// scripts/refresh-cards.ts
//
// One-off: re-edits EXISTING Discord cards for `pending` email_queue rows
// that were posted before the Phase 6 post-commit card-content fix (which
// added the "Original email" field and moved the draft into the embed
// description for a 4096-char cap instead of the 1024-char field cap).
//
// This is in-place: PATCHes each card via editCard() with the current
// buildCardPayload, so the message id is preserved, the Approve/Edit/Reject
// buttons stay attached to the same queue id, and Discord channel history
// is unchanged. No new messages are posted.
//
// Use case: the 9 stale pending cards from the June 20 backfill that
// predate the card-content fix. After running, every pending card shows
// the original email snippet alongside the draft so a reviewer can judge
// alignment without leaving Discord.
//
// Guarded: lists what it's about to do and requires an explicit "yes"
// before editing anything (it mutates real Discord messages).
//
//   npm run refresh:cards
//   tsx scripts/refresh-cards.ts

import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { and, eq, isNotNull } from 'drizzle-orm';
import { getDb } from '../lib/db.js';
import { emailQueue } from '../db/schema.js';
import { editCard, buildCardPayload } from '../lib/discord/rest.js';
import { getDiscordEnv } from '../types/env.js';

async function main() {
  const db = getDb();
  const { DISCORD_CHANNEL_ID } = getDiscordEnv();

  // Every pending row that already has a Discord card. We don't try to
  // detect "old format" vs "new format" — re-editing a new-format card
  // to the same payload is a harmless no-op on Discord's side and keeps
  // the script simple + idempotent.
  const rows = await db
    .select({
      id: emailQueue.id,
      fromAddr: emailQueue.fromAddr,
      fromName: emailQueue.fromName,
      subject: emailQueue.subject,
      category: emailQueue.category,
      draftReply: emailQueue.draftReply,
      bodySnippet: emailQueue.bodySnippet,
      receivedAt: emailQueue.receivedAt,
      discordMessageId: emailQueue.discordMessageId,
    })
    .from(emailQueue)
    .where(and(eq(emailQueue.status, 'pending'), isNotNull(emailQueue.discordMessageId)));

  if (rows.length === 0) {
    console.log('No pending rows with a Discord card. Nothing to refresh.');
    return;
  }

  console.log(`Found ${rows.length} pending row(s) with an existing Discord card:\n`);
  for (const r of rows) {
    console.log(`  ${r.id}  msg=${r.discordMessageId}  [${r.category ?? 'other'}]  "${r.subject ?? '(no subject)'}"`);
  }

  const rl = createInterface({ input, output });
  const answer = (
    await rl.question(
      `\nRe-edit all ${rows.length} card(s) in place to the current format (Original email field + 4096-char draft)? Type "yes" to proceed: `,
    )
  ).trim().toLowerCase();
  rl.close();
  if (answer !== 'yes') {
    console.log('aborted');
    return;
  }

  let refreshed = 0;
  let failed = 0;
  for (const r of rows) {
    try {
      const payload = buildCardPayload({
        id: r.id,
        fromAddr: r.fromAddr,
        fromName: r.fromName,
        subject: r.subject,
        category: r.category,
        draftReply: r.draftReply,
        bodySnippet: r.bodySnippet,
        receivedAt: r.receivedAt,
      });
      await editCardWithRetry(DISCORD_CHANNEL_ID, r.discordMessageId as string, payload);
      console.log(`  refreshed: ${r.id} -> msg ${r.discordMessageId}`);
      refreshed++;
    } catch (err) {
      const e = err as Error;
      console.error(`  FAILED: ${r.id} (msg ${r.discordMessageId}): ${e.message}`);
      failed++;
    }
  }

  console.log(`\nDone. refreshed=${refreshed} failed=${failed}`);
}

/**
 * editCard with retry on Discord's 429 rate limit. Discord returns
 * `retry_after` (seconds) in the 429 body; we sleep that long + a small
 * jitter and retry. Up to 5 attempts — Discord's "edits to messages
 * older than 1 hour" cap is a rolling window that drains over ~30s,
 * so a single retry after the retry_after usually clears it.
 */
async function editCardWithRetry(channelId: string, messageId: string, payload: Record<string, unknown>): Promise<void> {
  const MAX_ATTEMPTS = 5;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      await editCard(channelId, messageId, payload);
      return;
    } catch (err) {
      const e = err as Error;
      const isRateLimit = e.message.includes('429');
      if (!isRateLimit || attempt === MAX_ATTEMPTS) throw e;
      // Parse retry_after from the error message body, default to 5s.
      const match = e.message.match(/retry_after":\s*([\d.]+)/);
      const retryAfter = match ? parseFloat(match[1] as string) : 5;
      const wait = Math.ceil(retryAfter * 1000) + 500; // +0.5s jitter
      console.log(`  rate-limited on msg ${messageId}; sleeping ${wait}ms (attempt ${attempt}/${MAX_ATTEMPTS})`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

main().catch((err) => {
  console.error('refresh-cards crashed:', err);
  process.exit(1);
});