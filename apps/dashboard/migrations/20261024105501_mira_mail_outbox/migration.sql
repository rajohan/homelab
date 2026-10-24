CREATE TABLE "mira_mail_drafts" (
	"id" uuid PRIMARY KEY,
	"owner" text NOT NULL,
	"conversation_id" uuid,
	"inbox_id" text NOT NULL,
	"binding_hash" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"content" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"approved_version" integer,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"control_version" integer,
	"attempt_token" uuid,
	"started_at" timestamp with time zone,
	"provider_message_id" text,
	"provider_thread_id" text,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mira_mail_drafts_state" CHECK ("state" IN ('draft','queued','sending','sent','needs_attention','cancelled')),
	CONSTRAINT "mira_mail_drafts_version" CHECK ("version" >= 1),
	CONSTRAINT "mira_mail_drafts_approval" CHECK ("state" NOT IN ('queued','sending','sent','needs_attention') OR ("approved_version" IS NOT NULL AND "approved_by" IS NOT NULL AND "approved_at" IS NOT NULL AND "control_version" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX "mira_mail_drafts_owner" ON "mira_mail_drafts" ("owner","created_at","id");--> statement-breakpoint
CREATE INDEX "mira_mail_drafts_dispatch" ON "mira_mail_drafts" ("state","id");--> statement-breakpoint
ALTER TABLE "mira_mail_drafts" ADD CONSTRAINT "mira_mail_drafts_conversation_id_mira_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "mira_conversations"("id");