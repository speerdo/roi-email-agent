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
-- Data migration: scope the sync cursor by brand. COPY (not rename) the
-- existing ROI row to roi:INBOX: prod applies the migration and deploys the
-- new code as two separate steps, and with a rename whichever code is live
-- during that gap can't find its key, reseeds lastUid at 0 and re-walks the
-- inbox. The exact key is matched (NOT a LIKE pattern) so a crashed
-- scripts/db-smoke.ts preflight row (preflight-smoke-*/INBOX) can never be
-- adopted by mistake. The old row is left in place; delete it after the
-- cutover.
INSERT INTO "email_sync_state" ("mailbox", "last_uid")
SELECT 'roi:INBOX', "last_uid" FROM "email_sync_state"
WHERE "mailbox" = 'hello@recycleoldtech.com/INBOX'
ON CONFLICT ("mailbox") DO NOTHING;