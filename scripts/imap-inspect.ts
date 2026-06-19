// One-shot IMAP inspector: connects to the live mailbox and prints the
// next 5 unprocessed UIDs (or last_uid + 1:*), parsed bodies and the
// pre-filter result for each. Used to sanity-check lib/imap.ts and
// lib/mail/prefilter.ts against real mail BEFORE we wire them into the
// poller endpoint.
//
// Usage:
//   npm run imap:inspect                  # uses 0 as lastUid (first 5)
//   npm run imap:inspect -- --uid 12345   # resume from a known UID
//   npm run imap:inspect -- --limit 10    # fetch more

import 'dotenv/config';
import { connectImap, fetchSinceUid, type FetchedMessage } from '../lib/imap.js';
import { runPrefilters } from '../lib/mail/prefilter.js';
import { cleanBody, parseFromHeader } from '../lib/mail/clean.js';
import { getEnv } from '../types/env.js';

function parseArgs(): { uid: number; limit: number } {
  const args = process.argv.slice(2);
  let uid = 0;
  let limit = 5;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--uid' && args[i + 1]) {
      uid = Number(args[++i]);
    } else if (args[i] === '--limit' && args[i + 1]) {
      limit = Number(args[++i]);
    }
  }
  return { uid, limit };
}

async function main() {
  const env = getEnv();
  const { uid, limit } = parseArgs();
  const mailbox = 'INBOX';

  console.log(`=== IMAP inspect (mailbox=${mailbox}, lastUid=${uid}, limit=${limit}) ===\n`);

  const client = connectImap();
  try {
    await client.connect();
    console.log(`connected to ${env.EMAIL_IMAP_HOST}:${env.EMAIL_IMAP_PORT} as ${env.EMAIL_USER}`);

    const status = await client.status(mailbox, { messages: true, unseen: true });
    console.log(`INBOX status: messages=${status.messages} unseen=${status.unseen}\n`);

    let count = 0;
    for await (const msg of fetchSinceUid(client, mailbox, uid, { limit })) {
      count++;
      printMsg(msg);
    }
    console.log(`\nfetched ${count} message(s)`);
  } finally {
    try { await client.logout(); } catch { client.close(); }
  }
}

function printMsg(msg: FetchedMessage): void {
  const fromParsed = parseFromHeader(`${msg.fromName ?? ''} <${msg.fromAddr}>`);
  const pf = runPrefilters({ subject: msg.subject ?? '', from: fromParsed });
  const snippet = cleanBody(msg.text, 400);
  console.log('---');
  console.log(`uid:        ${msg.uid}`);
  console.log(`message-id: ${msg.messageId ?? '(none)'}`);
  console.log(`from:       ${msg.fromName ?? ''} <${msg.fromAddr}>`);
  console.log(`subject:    ${msg.subject ?? '(none)'}`);
  console.log(`received:   ${msg.receivedAt.toISOString()}`);
  console.log(`in-reply-to:${msg.inReplyTo ?? '(none)'}`);
  console.log(`references: ${msg.references ?? '(none)'}`);
  console.log(
    `prefilter:  ${pf.matched ? `MATCH category=${pf.category} skipReason=${pf.skipReason} markRead=${pf.markRead}` : 'no match -> LLM'}`,
  );
  console.log(`snippet:    ${snippet.slice(0, 400)}${snippet.length > 400 ? '…' : ''}`);
}

main().catch((err) => {
  console.error('imap:inspect crashed:', err);
  process.exit(1);
});