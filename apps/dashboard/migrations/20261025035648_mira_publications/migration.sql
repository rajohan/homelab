CREATE TABLE "mira_publications" (
	"id" uuid PRIMARY KEY,
	"owner" text NOT NULL,
	"conversation_id" uuid,
	"account_id" text NOT NULL,
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
	"retry_after" timestamp with time zone,
	"started_at" timestamp with time zone,
	"phase" text,
	"slug" text,
	"provider_version_id" text,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mira_publications_state" CHECK ("state" IN ('draft','queued','publishing','published','needs_attention','cancelled')),
	CONSTRAINT "mira_publications_version" CHECK ("version" >= 1),
	CONSTRAINT "mira_publications_approval" CHECK ("state" NOT IN ('queued','publishing','published','needs_attention') OR ("approved_version" IS NOT NULL AND "approved_by" IS NOT NULL AND "approved_at" IS NOT NULL AND "control_version" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX "mira_publications_owner" ON "mira_publications" ("owner","created_at","id");--> statement-breakpoint
CREATE INDEX "mira_publications_dispatch" ON "mira_publications" ("state","id");--> statement-breakpoint
CREATE UNIQUE INDEX "mira_publications_active_owner" ON "mira_publications" ("owner") WHERE "state" = 'publishing';--> statement-breakpoint
ALTER TABLE "mira_publications" ADD CONSTRAINT "mira_publications_conversation_id_mira_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "mira_conversations"("id");