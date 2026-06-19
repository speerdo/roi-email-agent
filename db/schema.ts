import { pgTable, uuid, text, integer, boolean, timestamp, index } from 'drizzle-orm/pg-core';

// email_queue — one row per inbound message (real, skipped, or error).
// status values: pending | approved | rejected | sent | skipped | error
// category values: recycling_request | newsletter | dmarc | spam |
//   listing_request | partner_inquiry | support | claim | out_of_scope | other
// (kept as text rather than pg enums for v2 extendability — see plan §6)
export const emailQueue = pgTable('email_queue', {
  id: uuid('id').primaryKey().defaultRandom(),
  messageId: text('message_id').unique().notNull(),
  imapUid: integer('imap_uid'),
  fromAddr: text('from_addr').notNull(),
  fromName: text('from_name'),
  subject: text('subject'),
  bodySnippet: text('body_snippet'),
  category: text('category'),
  shouldReply: boolean('should_reply').default(false),
  draftReply: text('draft_reply'),
  status: text('status').default('pending'),
  skipReason: text('skip_reason'),
  discordMessageId: text('discord_message_id'),
  inReplyTo: text('in_reply_to'),
  emailReferences: text('email_references'),
  errorDetail: text('error_detail'),
  receivedAt: timestamp('received_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  statusIdx: index('email_queue_status_idx').on(t.status),
  receivedAtIdx: index('email_queue_received_at_idx').on(t.receivedAt),
}));

// email_sync_state — incremental poller cursor. One row per mailbox key
// (e.g. "hello@recycleoldtech.com/INBOX"). Backlog modes do NOT touch this.
export const emailSyncState = pgTable('email_sync_state', {
  mailbox: text('mailbox').primaryKey(),
  lastUid: integer('last_uid').default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type EmailQueueRow = typeof emailQueue.$inferSelect;
export type NewEmailQueueRow = typeof emailQueue.$inferInsert;
export type EmailSyncStateRow = typeof emailSyncState.$inferSelect;
export type NewEmailSyncStateRow = typeof emailSyncState.$inferInsert;