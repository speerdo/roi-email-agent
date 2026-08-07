ALTER TABLE "email_queue" ADD COLUMN "location_hint" jsonb;--> statement-breakpoint
ALTER TABLE "email_queue" ADD COLUMN "resolved_city_url" text;