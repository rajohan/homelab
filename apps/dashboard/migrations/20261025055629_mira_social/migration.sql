CREATE TABLE "mira_social_cooldowns" (
	"owner" text PRIMARY KEY,
	"until" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mira_social_drafts" (
	"id" uuid PRIMARY KEY,
	"owner" text NOT NULL,
	"conversation_id" uuid,
	"agent_name" text NOT NULL,
	"binding_hash" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"content" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"approved_version" integer,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"control_stamp" text,
	"attempt_token" uuid,
	"retry_after" timestamp with time zone,
	"started_at" timestamp with time zone,
	"provider_id" text,
	"verification_code" text,
	"challenge" text,
	"expires_at" timestamp with time zone,
	"answer" text,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mira_social_drafts_version" CHECK ("version" >= 1),
	CONSTRAINT "mira_social_drafts_state" CHECK ("state" IN ('draft','queued','publishing','verification_required','queued_verification','verifying','submitted','needs_attention','cancelled')),
	CONSTRAINT "mira_social_drafts_approval" CHECK ("state" IN ('draft','cancelled') OR ("approved_version" IS NOT NULL AND "approved_by" IS NOT NULL AND "approved_at" IS NOT NULL AND "control_stamp" IS NOT NULL)),
	CONSTRAINT "mira_social_drafts_verification" CHECK ("state" NOT IN ('verification_required','queued_verification','verifying') OR ("provider_id" IS NOT NULL AND "verification_code" IS NOT NULL AND "challenge" IS NOT NULL AND "expires_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX "mira_social_drafts_owner" ON "mira_social_drafts" ("owner","created_at","id");--> statement-breakpoint
CREATE INDEX "mira_social_drafts_dispatch" ON "mira_social_drafts" ("state","id");--> statement-breakpoint
CREATE UNIQUE INDEX "mira_social_drafts_active_owner" ON "mira_social_drafts" ("owner") WHERE "state" IN ('publishing','verifying');--> statement-breakpoint
ALTER TABLE "mira_social_drafts" ADD CONSTRAINT "mira_social_drafts_conversation_id_mira_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "mira_conversations"("id");