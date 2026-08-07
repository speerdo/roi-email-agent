// scripts/bounce-digest.ts
//
// Weekly digest: posts a one-liner to the Discord approval channel
// summarizing the bounces pre-filtered in the last 7 days, with the
// failed recipient addresses and reasons extracted from the body snippets.
//
// Bounces are pre-filtered to skipped + read (SPEC §3.6) so they never
// generate a card individually; this digest is the only place they
// surface. Volume is ~2/week, so a single weekly message is plenty.
//
//   npm run bounce:digest
//
// Intended to be run by a weekly cron (add to vercel.json or an external
// scheduler). Reads from email_queue so it works regardless of IMAP state.

import 'dotenv/config';
import { and, eq, gte } from 'drizzle-orm';
import { getDb } from '../lib/db.js';
import { emailQueue } from '../db/schema.js';
import { getDiscordEnv } from '../types/env.js';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DISCORD_API = 'https://discord.com/api/v10';

/** Best-effort extraction of the failed recipient address from a bounce
 *  body snippet. Postfix/privateemail bounces include a
 *  `Final-Recipient: rfc822; <addr>` line; we look for that first, then
 *  fall back to a bare `<addr@example.com>` pattern. Returns null when
 *  nothing recognizable is present. */
function extractFailedAddress(snippet: string | null): string | null {
  if (!snippet) return null;
  const fr = snippet.match(/Final-Recipient:\s*rfc822;\s*([^\s<]+)/i);
  if (fr?.[1]) return fr[1].trim();
  const angled = snippet.match(/<([^<>@\s]+@[^<>@\s]+)>/);
  if (angled?.[1]) return angled[1].trim();
  return null;
}

/** Best-effort extraction of the bounce reason (SMTP status line). */
function extractReason(snippet: string | null): string | null {
  if (!snippet) return null;
  const m = snippet.match(/Diagnostic-Code:\s*([^\n]+)/i);
  if (m?.[1]) return m[1].trim().slice(0, 120);
  const status = snippet.match(/\b(5\d\d [\w. ]+)\b/);
  if (status?.[1]) return status[1].trim().slice(0, 120);
  return null;
}

async function main() {
  const db = getDb();
  const since = new Date(Date.now() - WEEK_MS);

  const rows = await db
    .select({
      id: emailQueue.id,
      subject: emailQueue.subject,
      bodySnippet: emailQueue.bodySnippet,
      fromAddr: emailQueue.fromAddr,
      receivedAt: emailQueue.receivedAt,
    })
    .from(emailQueue)
    .where(and(eq(emailQueue.category, 'bounce'), eq(emailQueue.skipReason, 'bounce'), gte(emailQueue.receivedAt, since)));

  if (rows.length === 0) {
    console.log('No bounces in the last 7 days.');
    return;
  }

  const lines: string[] = [`**Bounce digest — ${rows.length} in the last 7 days:**`];
  for (const r of rows) {
    const failed = extractFailedAddress(r.bodySnippet) ?? '(unknown)';
    const reason = extractReason(r.bodySnippet) ?? '(no reason extracted)';
    lines.push(`  ${failed} -> ${reason}`);
  }

  const content = lines.join('\n');
  console.log(content);

  const { DISCORD_CHANNEL_ID, DISCORD_BOT_TOKEN } = getDiscordEnv();
  const res = await fetch(`${DISCORD_API}/channels/${DISCORD_CHANNEL_ID}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Discord post failed: ${res.status} ${text.slice(0, 300)}`);
  }
  console.log('\nPosted digest to Discord.');
}

main().catch((err) => {
  console.error('bounce-digest crashed:', err);
  process.exit(1);
});