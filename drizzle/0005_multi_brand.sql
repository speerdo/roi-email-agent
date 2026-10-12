CREATE TABLE "newsletter_subscribers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"brand" text NOT NULL,
	"email" text NOT NULL,
	"source_page" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "email_queue" ADD COLUMN "brand" text DEFAULT 'roi' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "newsletter_subscribers_brand_email_idx" ON "newsletter_subscribers" USING btree ("brand","email");--> statement-breakpoint
-- Data migration: scope the sync cursor by brand. There is exactly one
-- pre-existing row (the ROI poller's `hello@recycleoldtech.com/INBOX`);
-- adopt it as roi:INBOX so the ROI cursor (lastUid) is preserved. DOWNTOWNDRY
-- is brand-new and seeds its own row at 0 on first poll.
UPDATE "email_sync_state" SET "mailbox" = 'roi:INBOX' WHERE "mailbox" LIKE '%/INBOX';