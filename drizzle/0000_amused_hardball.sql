CREATE TABLE "email_queue" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" text NOT NULL,
	"imap_uid" integer,
	"from_addr" text NOT NULL,
	"from_name" text,
	"subject" text,
	"body_snippet" text,
	"category" text,
	"should_reply" boolean DEFAULT false,
	"draft_reply" text,
	"status" text DEFAULT 'pending',
	"skip_reason" text,
	"discord_message_id" text,
	"in_reply_to" text,
	"email_references" text,
	"error_detail" text,
	"received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_queue_message_id_unique" UNIQUE("message_id")
);
--> statement-breakpoint
CREATE TABLE "email_sync_state" (
	"mailbox" text PRIMARY KEY NOT NULL,
	"last_uid" integer DEFAULT 0,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "email_queue_status_idx" ON "email_queue" USING btree ("status");--> statement-breakpoint
CREATE INDEX "email_queue_received_at_idx" ON "email_queue" USING btree ("received_at");