CREATE TABLE "mira_improvement_grants" (
	"automation_id" uuid PRIMARY KEY,
	"owner" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"automation_version" integer NOT NULL,
	"binding_hash" text,
	"approved_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mira_improvements" (
	"id" uuid PRIMARY KEY,
	"owner" text NOT NULL,
	"run_id" uuid NOT NULL UNIQUE,
	"conversation_id" uuid NOT NULL,
	"automation_id" uuid NOT NULL,
	"grant_version" integer NOT NULL,
	"binding_hash" text NOT NULL,
	"automation_control" integer NOT NULL,
	"autonomy_control" integer NOT NULL,
	"policy_version" integer NOT NULL,
	"daytona_control" integer NOT NULL,
	"github_control" integer NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"content" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"cloud_hash" text,
	"publication_hash" text,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"message" text,
	"report_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mira_improvements_state" CHECK ("state" IN ('queued','checking','publishing','published','failed','cancelled','needs_attention'))
);
--> statement-breakpoint
CREATE INDEX "mira_improvements_queue" ON "mira_improvements" ("state","id");--> statement-breakpoint
CREATE INDEX "mira_improvements_owner" ON "mira_improvements" ("owner","id");--> statement-breakpoint
CREATE UNIQUE INDEX "mira_improvements_one_active" ON "mira_improvements" ((true)) WHERE "state" IN ('queued','checking','publishing');--> statement-breakpoint
ALTER TABLE "mira_improvement_grants" ADD CONSTRAINT "mira_improvement_grants_automation_id_mira_automations_id_fkey" FOREIGN KEY ("automation_id") REFERENCES "mira_automations"("id");--> statement-breakpoint
ALTER TABLE "mira_improvements" ADD CONSTRAINT "mira_improvements_run_id_mira_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "mira_runs"("id");--> statement-breakpoint
ALTER TABLE "mira_improvements" ADD CONSTRAINT "mira_improvements_conversation_id_mira_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "mira_conversations"("id");--> statement-breakpoint
ALTER TABLE "mira_improvements" ADD CONSTRAINT "mira_improvements_automation_id_mira_automations_id_fkey" FOREIGN KEY ("automation_id") REFERENCES "mira_automations"("id");