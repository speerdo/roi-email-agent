// Send a real test email via the SMTP path to verify wiring. Guarded:
// refuses to run without an explicit --to <address> and prints a
// confirmation prompt before sending. Only run on Adam's explicit
// go-ahead.
//
//   npm run test:smtp -- --to adam@example.com

import 'dotenv/config';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { sendReply } from '../lib/smtp.js';

function parseArgs(): { to?: string } {
  const args = process.argv.slice(2);
  const out: { to?: string } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--to' && args[i + 1]) out.to = args[++i];
    else if (args[i] === '--help' || args[i] === '-h') {
      console.log('Usage: npm run test:smtp -- --to <recipient@example.com>');
      process.exit(0);
    }
  }
  return out;
}

async function main() {
  const a = parseArgs();
  if (!a.to) {
    console.error('refusing to run: --to <recipient> is required.');
    console.error('this script sends a real email. Use a mailbox you own.');
    process.exit(1);
  }

  console.log(`About to send a test reply:
  to:       ${a.to}
  subject:  RecycleOldTech triage agent — SMTP test
  body:     This is a test message from the RecycleOldTech email triage
            agent's SMTP path. If you received this, lib/smtp.ts works
            end-to-end. (inReplyTo / references omitted — this is a
            standalone test, not a threaded reply.)
`);
  const rl = createInterface({ input, output });
  const answer = (await rl.question('Type "yes" to send, anything else to abort: ')).trim().toLowerCase();
  rl.close();
  if (answer !== 'yes') {
    console.log('aborted');
    process.exit(0);
  }

  console.log('sending...');
  const result = await sendReply({
    to: a.to,
    subject: 'RecycleOldTech triage agent — SMTP test',
    text:
      'This is a test message from the RecycleOldTech email triage agent\'s ' +
      'SMTP path. If you received this, lib/smtp.ts works end-to-end.\n\n' +
      '(inReplyTo / references omitted — this is a standalone test, not a threaded reply.)',
  });

  console.log('\nsend result:');
  console.log(JSON.stringify(result, null, 2));
  if (result.messageId) {
    console.log('\nSUCCESS — recipient should receive the email shortly.');
  } else {
    console.log('\nWARNING — sendMail returned but no messageId; check transport.');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('test:smtp crashed:', err);
  process.exit(1);
});