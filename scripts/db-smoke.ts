import 'dotenv/config';
import { eq, sql } from 'drizzle-orm';
import { getDb, resetDbCache } from '../lib/db.js';
import { emailQueue, emailSyncState } from '../db/schema.js';

async function main() {
  resetDbCache();
  const db = getDb();

  const testMessageId = `preflight-smoke-${Date.now()}@roi-email-agent.local`;
  const testMailbox = `preflight-smoke-${Date.now()}/INBOX`;

  try {
    // 1. Insert into email_queue
    const inserted = await db
      .insert(emailQueue)
      .values({
        messageId: testMessageId,
        imapUid: 999999,
        fromAddr: 'smoke@example.com',
        fromName: 'Smoke Test',
        subject: 'db-smoke round trip',
        bodySnippet: 'sent by scripts/db-smoke.ts',
        category: 'other',
        shouldReply: false,
        status: 'pending',
      })
      .returning({ id: emailQueue.id });
    const rowId = inserted[0]?.id;
    if (!rowId) throw new Error('insert returned no id');
    console.log(`[PASS] email_queue insert -> id=${rowId}`);

    // 2. Select it back
    const selected = await db
      .select()
      .from(emailQueue)
      .where(eq(emailQueue.id, rowId));
    if (selected.length !== 1) throw new Error(`expected 1 row, got ${selected.length}`);
    const row = selected[0];
    if (!row) throw new Error('selected row missing');
    if (row.messageId !== testMessageId) throw new Error('messageId mismatch');
    console.log(`[PASS] email_queue select -> messageId=${row.messageId}`);

    // 3. Insert into email_sync_state
    await db
      .insert(emailSyncState)
      .values({ mailbox: testMailbox, lastUid: 999999 });
    console.log(`[PASS] email_sync_state insert`);

    // 4. Update lastUid + read back
    await db
      .update(emailSyncState)
      .set({ lastUid: 1000000, updatedAt: new Date() })
      .where(eq(emailSyncState.mailbox, testMailbox));
    const syncRow = await db
      .select()
      .from(emailSyncState)
      .where(eq(emailSyncState.mailbox, testMailbox));
    if (syncRow[0]?.lastUid !== 1000000) throw new Error('lastUid update failed');
    console.log(`[PASS] email_sync_state update + select -> lastUid=${syncRow[0].lastUid}`);

    // 5. Cleanup
    await db.delete(emailQueue).where(eq(emailQueue.id, rowId));
    await db.delete(emailSyncState).where(eq(emailSyncState.mailbox, testMailbox));
    console.log('[PASS] cleanup complete');
  } catch (err) {
    const e = err as Error;
    console.error('[FAIL] db-smoke:', e.message);
    // Best-effort cleanup
    try {
      const db2 = getDb();
      await db2.delete(emailQueue).where(sql`message_id = ${testMessageId}`);
      await db2.delete(emailSyncState).where(eq(emailSyncState.mailbox, testMailbox));
    } catch { /* best-effort */ }
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('db-smoke crashed:', err);
  process.exit(2);
});