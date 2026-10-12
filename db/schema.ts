import { pgTable, uuid, text, integer, boolean, timestamp, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';

// email_queue — one row per inbound message (real, skipped, or error).
// status values: pending | approved | rejected | sent | skipped | error
//   (plus 'sending' as a transient claim state for Approve idempotency —
//   see api/discord.ts handleApprove conditional-write guard).
// brand: which brand profile owns the row ('roi' | 'downtowndry'). Drives
//   the SMTP credentials, From name, signature, Discord channel and
//   prefilter/Gemini config used at approve time (api/discord.ts loads the
//   row, then getBrand(row.brand)). Default 'roi' covers all pre-existing
//   rows (migration 0005).
// category values: recycling_help | recycling_request | newsletter | dmarc |
//   bounce | spam | listing_request | partner_inquiry | support | claim |
//   out_of_scope | other
//   (recycling_help: a person asking where/how to recycle items, reply-worthy,
//    composed from a deterministic city-page template — see SPEC §2.3.
//    recycling_request: the Web3Forms city-page form, pre-filtered to
//    Make.com-handled. The two are deliberately distinct.
//    bounce: MAILER-DAEMON / multipart/report delivery-status notifications,
//    pre-filtered to skipped + read; surfaced via a weekly digest — §3.6.)
// (kept as text rather than pg enums for v2 extendability — see plan §6)
export const emailQueue = pgTable('email_queue', {
  id: uuid('id').primaryKey().defaultRandom(),
  brand: text('brand').notNull().default('roi'),
  messageId: text('message_id').unique().notNull(),
  imapUid: integer('imap_uid'),
  fromAddr: text('from_addr').notNull(),
  fromName: text('from_name'),
  // Reply-To header resolved at parse time (lib/imap.ts parseFetched).
  // For most senders this is null and replies go to fromAddr. For
  // automated senders that wrap real humans (Web3Forms, mailing lists,
  // ticketing systems), this holds the actual human address and is what
  // replies MUST use. See lib/mail/recipient.ts replyRecipient().
  replyTo: text('reply_to'),
  subject: text('subject'),
  bodySnippet: text('body_snippet'),
  category: text('category'),
  shouldReply: boolean('should_reply').default(false),
  draftReply: text('draft_reply'),
  // status values: pending | approved | rejected | sent | skipped | error
  //   (plus 'sending' as a transient claim state for Approve idempotency —
  //   see api/discord.ts handleApprove conditional-write guard).
  status: text('status').default('pending'),
  skipReason: text('skip_reason'),
  discordMessageId: text('discord_message_id'),
  inReplyTo: text('in_reply_to'),
  emailReferences: text('email_references'),
  errorDetail: text('error_detail'),
  // recycling_help audit trail (SPEC §2.7). The model emits structured
  // location fields; code resolves them to a real city-page URL from the
  // site index. Persist all three (location hint, resolved URL, routing
  // label) so a bad resolution is traceable after the fact, the §2.8
  // deflection report is a one-line query, and the post-approve card
  // re-edit can show the same routing line without re-resolving.
  locationHint: jsonb('location_hint'),
  resolvedCityUrl: text('resolved_city_url'),
  routingLabel: text('routing_label'),
  receivedAt: timestamp('received_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  statusIdx: index('email_queue_status_idx').on(t.status),
  receivedAtIdx: index('email_queue_received_at_idx').on(t.receivedAt),
}));

// email_sync_state — incremental poller cursor. One row per sync key.
// Key format: `<brand>:INBOX` (e.g. "roi:INBOX") since Task 3 — each brand
// polls its own mailbox and MUST NOT reuse another brand's lastUid.
// Migration 0005 renames the single pre-existing ROI row
// (previously keyed `hello@recycleoldtech.com/INBOX`) to `roi:INBOX`.
// Backlog modes do NOT touch this.
export const emailSyncState = pgTable('email_sync_state', {
  mailbox: text('mailbox').primaryKey(),
  lastUid: integer('last_uid').default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

// newsletter_subscribers — per-brand newsletter capture (DowntownDry).
// When a DD message matches the newsletter pre-filter (subject contains
// "New Newsletter Subscriber"), the runner parses the subscriber address
// (`email : x` in the body) and the page name (subject suffix), and
// upserts a row here. unique(brand, email): a repeat signup updates
// last_seen_at and is NOT re-announced.
export const newsletterSubscribers = pgTable('newsletter_subscribers', {
  id: uuid('id').primaryKey().defaultRandom(),
  brand: text('brand').notNull(),
  email: text('email').notNull(),
  sourcePage: text('source_page'),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => ({
  brandEmailIdx: uniqueIndex('newsletter_subscribers_brand_email_idx').on(t.brand, t.email),
}));

// alert_state — de-duplication state for the Discord error alert, one row
// per alert key (the poller uses its mailbox key). Cron runs every 10
// minutes in a serverless function, so "have I already reported this?"
// cannot live in process memory; it has to be durable.
//
// `fingerprint` is a normalized digest of what was wrong (see
// lib/alerts.ts fingerprintRun). While it stays the same we post once,
// then only on the reminder interval, counting the silent ticks in
// `occurrences`. When it changes or clears, we post again — so a NEW
// failure is never masked by an ongoing one.
export const alertState = pgTable('alert_state', {
  key: text('key').primaryKey(),
  fingerprint: text('fingerprint').notNull(),
  /** Consecutive runs that reported this same fingerprint, including the
   *  ones suppressed. Surfaced in the reminder so a reader can tell a
   *  blip from a 6-hour outage. */
  occurrences: integer('occurrences').notNull().default(1),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }).defaultNow().notNull(),
  lastPostedAt: timestamp('last_posted_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
});

export type EmailQueueRow = typeof emailQueue.$inferSelect;
export type NewEmailQueueRow = typeof emailQueue.$inferInsert;
export type EmailSyncStateRow = typeof emailSyncState.$inferSelect;
export type NewEmailSyncStateRow = typeof emailSyncState.$inferInsert;
export type AlertStateRow = typeof alertState.$inferSelect;
export type NewAlertStateRow = typeof alertState.$inferInsert;
export type NewsletterSubscriberRow = typeof newsletterSubscribers.$inferSelect;
export type NewNewsletterSubscriberRow = typeof newsletterSubscribers.$inferInsert;
