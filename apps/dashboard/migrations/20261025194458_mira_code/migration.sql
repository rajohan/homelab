CREATE TABLE "mira_code_publications" (
	"id" uuid PRIMARY KEY,
	"owner" text NOT NULL,
	"conversation_id" uuid,
	"check_id" uuid NOT NULL,
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
	"authored_at" text,
	"phase" text,
	"branch" text,
	"tree" text,
	"commit" text,
	"number" integer,
	"observation" jsonb,
	"inspection_requested" boolean DEFAULT false NOT NULL,
	"inspection_token" uuid,
	"inspection_started_at" timestamp with time zone,
	"observed_at" timestamp with time zone,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mira_code_state" CHECK ("state" IN ('draft','queued','publishing','published','needs_attention','cancelled')),
	CONSTRAINT "mira_code_version" CHECK ("version" >= 1),
	CONSTRAINT "mira_code_approval" CHECK ("state" NOT IN ('queued','publishing','published','needs_attention') OR ("approved_version" IS NOT NULL AND "approved_by" IS NOT NULL AND "approved_at" IS NOT NULL AND "control_version" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX "mira_code_owner" ON "mira_code_publications" ("owner","created_at","id");--> statement-breakpoint
CREATE INDEX "mira_code_queue" ON "mira_code_publications" ("state","id");--> statement-breakpoint
CREATE UNIQUE INDEX "mira_code_one_active" ON "mira_code_publications" ((true)) WHERE "state"='publishing';--> statement-breakpoint
CREATE UNIQUE INDEX "mira_code_check_once" ON "mira_code_publications" ("check_id") WHERE "state" NOT IN ('draft','cancelled');--> statement-breakpoint
ALTER TABLE "mira_code_publications" ADD CONSTRAINT "mira_code_publications_rYj2ZKQMF2dK_fkey" FOREIGN KEY ("conversation_id") REFERENCES "mira_conversations"("id");--> statement-breakpoint
ALTER TABLE "mira_code_publications" ADD CONSTRAINT "mira_code_publications_check_id_mira_daytona_jobs_id_fkey" FOREIGN KEY ("check_id") REFERENCES "mira_daytona_jobs"("id");