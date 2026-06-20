import 'dotenv/config';
import { getDb } from '../lib/db.js';
import { emailQueue } from '../db/schema.js';
import { eq } from 'drizzle-orm';

async function main() {
  const db = getDb();
  const rows = await db
    .select({
      id: emailQueue.id,
      status: emailQueue.status,
      fromAddr: emailQueue.fromAddr,
      subject: emailQueue.subject,
      category: emailQueue.category,
      shouldReply: emailQueue.shouldReply,
      draftReply: emailQueue.draftReply,
      receivedAt: emailQueue.receivedAt,
    })
    .from(emailQueue)
    .orderBy(emailQueue.receivedAt)
    .limit(15);
  console.log(`id\tstatus\tcategory\tfrom\tsubject`);
  for (const r of rows) {
    const subj = (r.subject ?? '').slice(0, 40);
    console.log(`${r.id}\t${r.status}\t${r.category ?? '-'}\t${r.fromAddr}\t${subj}`);
  }
  console.log(`\n-- pending only --`);
  const pending = await db
    .select({ id: emailQueue.id, subject: emailQueue.subject, fromAddr: emailQueue.fromAddr, shouldReply: emailQueue.shouldReply, draftReply: emailQueue.draftReply })
    .from(emailQueue)
    .where(eq(emailQueue.status, 'pending'))
    .limit(5);
  console.log(`count: ${pending.length}`);
  console.log(JSON.stringify(pending, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });