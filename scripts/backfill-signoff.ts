// scripts/backfill-signoff.ts
//
// One-off: strips the house sign-off out of the STORED draft on `pending`
// email_queue rows, then re-edits their Discord cards in place so the card
// shows exactly what the recipient will get.
//
// Why this exists: the original fix stripped the sign-off only at SMTP
// time (lib/smtp.ts), so the sent email was clean but the stored draft --
// and therefore the Discord card, the "Sent" card and the edit modal --
// still ended in "RecycleOldTech / Adam". Stripping now happens where the
// draft is written (lib/poll/runner.ts and the Discord edit-modal handler),
// but rows queued before that change still carry the old text. This
// normalizes them.
//
// Only `pending` rows are touched: a `sent` row's draft is the audit record
// of what we composed, and rewriting history there would be a lie (the
// email that actually went out was already stripped at send time).
//
// Guarded: prints the exact before/after tail of every row and requires an
// explicit "yes" before writing anything.
//
//   npm run backfill:signoff
//   tsx scripts/backfill-signoff.ts

import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { and, eq, isNotNull } from 'drizzle-orm';
import { getDb } from '../lib/db.js';
import { emailQueue } from '../db/schema.js';
import { stripDraftSignoff } from '../lib/mail/signature.js';
import { editCard, buildCardPayload } from '../lib/discord/rest.js';
import { getDiscordEnv } from '../types/env.js';

/** Last 60 chars on one line, for a readable before/after diff. */
function tail(s: string): string {
  return JSON.stringify(s.slice(-60));
}

async function main() {
  const db = getDb();
  const { DISCORD_CHANNEL_ID } = getDiscordEnv();

  const rows = await db
    .select({
      id: emailQueue.id,
      fromAddr: emailQueue.fromAddr,
      fromName: emailQueue.fromName,
      replyTo: emailQueue.replyTo,
      subject: emailQueue.subject,
      category: emailQueue.category,
      draftReply: emailQueue.draftReply,
      bodySnippet: emailQueue.bodySnippet,
      receivedAt: emailQueue.receivedAt,
      discordMessageId: emailQueue.discordMessageId,
      routingLabel: emailQueue.routingLabel,
    })
    .from(emailQueue)
    .where(and(eq(emailQueue.status, 'pending'), isNotNull(emailQueue.draftReply)));

  // A draft that is nothing BUT a sign-off would strip to empty, which the
  // approve path refuses to send. Leave those for a human to rewrite.
  const changed = rows
    .map((r) => ({ row: r, stripped: stripDraftSignoff(r.draftReply ?? '') }))
    .filter(({ row, stripped }) => stripped !== row.draftReply && stripped.trim() !== '');

  if (changed.length === 0) {
    console.log('No pending drafts carry a sign-off. Nothing to backfill.');
    return;
  }

  console.log(`${changed.length} of ${rows.length} pending draft(s) end in a sign-off:\n`);
  for (const { row, stripped } of changed) {
    console.log(`  ${row.id}  [${row.category ?? 'other'}]  "${row.subject ?? '(no subject)'}"`);
    console.log(`    before: ${tail(row.draftReply ?? '')}`);
    console.log(`    after:  ${tail(stripped)}`);
  }

  const rl = createInterface({ input, output });
  const answer = (
    await rl.question(
      `\nStrip the sign-off on all ${changed.length} row(s) and re-edit their cards? Type "yes" to proceed: `,
    )
  ).trim().toLowerCase();
  rl.close();
  if (answer !== 'yes') {
    console.log('aborted');
    return;
  }

  let updated = 0;
  let refreshed = 0;
  let failed = 0;
  for (const { row, stripped } of changed) {
    await db
      .update(emailQueue)
      .set({ draftReply: stripped, updatedAt: new Date() })
      .where(eq(emailQueue.id, row.id));
    updated++;

    // The card is a mirror of the row; a row without one just skips here.
    if (!row.discordMessageId) {
      console.log(`  updated: ${row.id} (no Discord card to refresh)`);
      continue;
    }
    try {
      const payload = buildCardPayload({
        id: row.id,
        fromAddr: row.fromAddr,
        fromName: row.fromName,
        replyTo: row.replyTo,
        subject: row.subject,
        category: row.category,
        draftReply: stripped,
        bodySnippet: row.bodySnippet,
        receivedAt: row.receivedAt,
        routing: row.routingLabel,
      });
      await editCardWithRetry(DISCORD_CHANNEL_ID, row.discordMessageId, payload);
      console.log(`  updated + refreshed: ${row.id} -> msg ${row.discordMessageId}`);
      refreshed++;
    } catch (err) {
      // Non-fatal: the row is already correct, only its card is stale. The
      // send path reads the row, so the email is right either way.
      const e = err as Error;
      console.error(`  card refresh FAILED (row updated): ${row.id}: ${e.message}`);
      failed++;
    }
  }

  console.log(`\nDone. updated=${updated} cardsRefreshed=${refreshed} cardsFailed=${failed}`);
}

/**
 * editCard with retry on Discord's 429 rate limit — same shape as
 * scripts/refresh-cards.ts, which hits the same per-channel edit cap when
 * it walks every pending card in one pass.
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
      const match = e.message.match(/retry_after":\s*([\d.]+)/);
      const retryAfter = match ? parseFloat(match[1] as string) : 5;
      const wait = Math.ceil(retryAfter * 1000) + 500;
      console.log(`  rate-limited on msg ${messageId}; sleeping ${wait}ms (attempt ${attempt}/${MAX_ATTEMPTS})`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

main().catch((err) => {
  console.error('backfill-signoff crashed:', err);
  process.exit(1);
});
