CREATE TABLE "mira_daytona_jobs" (
	"id" uuid PRIMARY KEY,
	"owner" text NOT NULL,
	"conversation_id" uuid,
	"task_id" uuid,
	"binding" jsonb NOT NULL,
	"binding_hash" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"content" jsonb NOT NULL,
	"content_hash" text NOT NULL,
	"state" text DEFAULT 'draft' NOT NULL,
	"phase" text DEFAULT 'idle' NOT NULL,
	"cleanup" text DEFAULT 'not_needed' NOT NULL,
	"outcome" text,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"approved_at" timestamp with time zone,
	"control_version" integer,
	"started_at" timestamp with time zone,
	"deadline" timestamp with time zone,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"retry_at" timestamp with time zone,
	"sandbox_id" uuid,
	"command_id" text,
	"upload_index" integer DEFAULT 0 NOT NULL,
	"delete_attempted" boolean DEFAULT false NOT NULL,
	"exit_code" integer,
	"stdout" text DEFAULT '' NOT NULL,
	"stderr" text DEFAULT '' NOT NULL,
	"output" text DEFAULT '' NOT NULL,
	"files" jsonb DEFAULT '[]' NOT NULL,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mira_daytona_state" CHECK ("state" IN ('draft','queued','running','completed','failed','cancelled','needs_attention')),
	CONSTRAINT "mira_daytona_cleanup" CHECK ("cleanup" IN ('not_needed','pending','confirmed')),
	CONSTRAINT "mira_daytona_outcome" CHECK ("outcome" IS NULL OR "outcome" IN ('completed','failed','cancelled','needs_attention')),
	CONSTRAINT "mira_daytona_version" CHECK ("version">0),
	CONSTRAINT "mira_daytona_upload" CHECK ("upload_index" BETWEEN 0 AND 4),
	CONSTRAINT "mira_daytona_logs" CHECK (octet_length("stdout")+octet_length("stderr")+octet_length("output")<=131072)
);
--> statement-breakpoint
CREATE INDEX "mira_daytona_owner" ON "mira_daytona_jobs" ("owner","created_at","id");--> statement-breakpoint
CREATE INDEX "mira_daytona_dispatch" ON "mira_daytona_jobs" ("cleanup","state","retry_at");--> statement-breakpoint
CREATE INDEX "mira_daytona_admission" ON "mira_daytona_jobs" ("started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mira_daytona_single_active" ON "mira_daytona_jobs" ((true)) WHERE "cleanup"='pending';--> statement-breakpoint
ALTER TABLE "mira_daytona_jobs" ADD CONSTRAINT "mira_daytona_jobs_conversation_id_mira_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "mira_conversations"("id");--> statement-breakpoint
ALTER TABLE "mira_daytona_jobs" ADD CONSTRAINT "mira_daytona_jobs_task_id_mira_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "mira_tasks"("id");