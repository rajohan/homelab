CREATE TABLE "mira_attachments" (
	"id" uuid PRIMARY KEY,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"media_type" text NOT NULL,
	"bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"ready_at" timestamp with time zone,
	"purged_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mira_attachments_size" CHECK ("bytes" between 1 and 26214400)
);
--> statement-breakpoint
CREATE TABLE "mira_audit" (
	"id" uuid PRIMARY KEY,
	"owner" text NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mira_automations" (
	"id" uuid PRIMARY KEY,
	"owner" text NOT NULL,
	"title" text NOT NULL,
	"prompt" text NOT NULL,
	"kind" text NOT NULL,
	"delivery" text DEFAULT 'changes' NOT NULL,
	"schedule" jsonb NOT NULL,
	"budget_seconds" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"next_run_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mira_automations_budget" CHECK ("budget_seconds" between 30 and 900),
	CONSTRAINT "mira_automations_delivery" CHECK ("delivery" in ('reports','changes','silent'))
);
--> statement-breakpoint
CREATE TABLE "mira_conversations" (
	"id" uuid PRIMARY KEY,
	"owner" text NOT NULL,
	"title" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"provider_thread" text,
	"model" text,
	"archived_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mira_event_deliveries" (
	"event_id" uuid,
	"automation_id" uuid,
	"state" text DEFAULT 'pending' NOT NULL,
	"run_id" uuid,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mira_event_deliveries_pkey" PRIMARY KEY("event_id","automation_id"),
	CONSTRAINT "mira_events_delivery_state" CHECK ("state" in ('pending','dispatched','skipped'))
);
--> statement-breakpoint
CREATE TABLE "mira_events" (
	"id" uuid PRIMARY KEY,
	"owner" text NOT NULL,
	"kind" text NOT NULL,
	"source_key" text NOT NULL,
	"reference" text NOT NULL,
	"task_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mira_memory" (
	"id" uuid PRIMARY KEY,
	"owner" text NOT NULL,
	"title" text NOT NULL,
	"content" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mira_messages" (
	"id" uuid PRIMARY KEY,
	"conversation_id" uuid NOT NULL,
	"role" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"state" text NOT NULL,
	"attachment_ids" jsonb DEFAULT '[]' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mira_messages_role" CHECK ("role" in ('user','assistant')),
	CONSTRAINT "mira_messages_state" CHECK ("state" in ('queued','streaming','completed','interrupted','failed')),
	CONSTRAINT "mira_messages_length" CHECK (length("content") <= 256000)
);
--> statement-breakpoint
CREATE TABLE "mira_notice_state" (
	"owner" text,
	"key" text,
	"fingerprint" text NOT NULL,
	CONSTRAINT "mira_notice_state_pkey" PRIMARY KEY("owner","key")
);
--> statement-breakpoint
CREATE TABLE "mira_progress" (
	"id" uuid PRIMARY KEY,
	"task_id" uuid NOT NULL,
	"actor" text NOT NULL,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mira_reports" (
	"id" uuid PRIMARY KEY,
	"owner" text NOT NULL,
	"title" text NOT NULL,
	"kind" text NOT NULL,
	"markdown" text NOT NULL,
	"run_id" uuid,
	"task_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"archived_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mira_runs" (
	"id" uuid PRIMARY KEY,
	"owner" text NOT NULL,
	"request_key" text NOT NULL UNIQUE,
	"request_hash" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"user_message_id" uuid NOT NULL,
	"assistant_message_id" uuid NOT NULL,
	"task_id" uuid,
	"automation_id" uuid,
	"state" text NOT NULL,
	"priority" integer NOT NULL,
	"lane" text,
	"manual" boolean DEFAULT false NOT NULL,
	"budget_seconds" integer NOT NULL,
	"worker_id" uuid,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"message" text,
	"provider_turn" text,
	"observation_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "mira_runs_state" CHECK ("state" in ('queued','running','completed','interrupted','failed','needs_attention'))
);
--> statement-breakpoint
CREATE TABLE "mira_runtime_status" (
	"id" integer PRIMARY KEY DEFAULT 1,
	"worker_id" uuid NOT NULL,
	"version" text NOT NULL,
	"model" text,
	"ready" boolean NOT NULL,
	"message" text,
	"heartbeat_at" timestamp with time zone NOT NULL,
	CONSTRAINT "mira_runtime_status_singleton" CHECK ("id" = 1)
);
--> statement-breakpoint
CREATE TABLE "mira_switches" (
	"owner" text,
	"key" text,
	"enabled" boolean NOT NULL,
	"reason" text,
	"until" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "mira_switches_pkey" PRIMARY KEY("owner","key"),
	CONSTRAINT "mira_switches_intent" CHECK (("enabled" and "reason" is null and "until" is null) or (not "enabled" and length("reason") between 1 and 1000))
);
--> statement-breakpoint
CREATE TABLE "mira_tasks" (
	"id" uuid PRIMARY KEY,
	"owner" text NOT NULL,
	"title" text NOT NULL,
	"description" text NOT NULL,
	"status" text NOT NULL,
	"assignee" text NOT NULL,
	"priority" text NOT NULL,
	"labels" jsonb DEFAULT '[]' NOT NULL,
	"due_at" timestamp with time zone,
	"completion_criteria" text NOT NULL,
	"conversation_id" uuid,
	"version" integer DEFAULT 1 NOT NULL,
	"deleted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mira_tasks_state" CHECK ("status" in ('todo','in_progress','blocked','done')),
	CONSTRAINT "mira_tasks_assignee" CHECK ("assignee" in ('mira','operator')),
	CONSTRAINT "mira_tasks_priority" CHECK ("priority" in ('low','normal','high','urgent'))
);
--> statement-breakpoint
CREATE TABLE "mira_tool_receipts" (
	"id" uuid PRIMARY KEY,
	"run_id" uuid NOT NULL,
	"call_id" text NOT NULL,
	"tool" text NOT NULL,
	"input_hash" text NOT NULL,
	"state" text NOT NULL,
	"message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "dashboard_notifications" ADD COLUMN "recipient" text;--> statement-breakpoint
CREATE INDEX "mira_attachments_owner" ON "mira_attachments" ("owner","id");--> statement-breakpoint
CREATE INDEX "mira_audit_owner" ON "mira_audit" ("owner","id");--> statement-breakpoint
CREATE INDEX "mira_automations_due" ON "mira_automations" ("next_run_at");--> statement-breakpoint
CREATE INDEX "mira_conversations_owner" ON "mira_conversations" ("owner","id");--> statement-breakpoint
CREATE INDEX "mira_events_pending" ON "mira_event_deliveries" ("state","next_attempt_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mira_events_source" ON "mira_events" ("owner","kind","source_key");--> statement-breakpoint
CREATE INDEX "mira_memory_owner" ON "mira_memory" ("owner","id");--> statement-breakpoint
CREATE INDEX "mira_messages_conversation" ON "mira_messages" ("conversation_id","id");--> statement-breakpoint
CREATE INDEX "mira_progress_task" ON "mira_progress" ("task_id","id");--> statement-breakpoint
CREATE INDEX "mira_reports_owner" ON "mira_reports" ("owner","id");--> statement-breakpoint
CREATE INDEX "mira_runs_queue" ON "mira_runs" ("state","priority","id");--> statement-breakpoint
CREATE INDEX "mira_runs_owner" ON "mira_runs" ("owner","id");--> statement-breakpoint
CREATE UNIQUE INDEX "mira_runs_one_active_conversation" ON "mira_runs" ("conversation_id") WHERE "state" in ('queued','running');--> statement-breakpoint
CREATE INDEX "mira_tasks_owner" ON "mira_tasks" ("owner","id");--> statement-breakpoint
CREATE UNIQUE INDEX "mira_tool_receipts_call" ON "mira_tool_receipts" ("run_id","call_id");--> statement-breakpoint
ALTER TABLE "mira_event_deliveries" ADD CONSTRAINT "mira_event_deliveries_event_id_mira_events_id_fkey" FOREIGN KEY ("event_id") REFERENCES "mira_events"("id");--> statement-breakpoint
ALTER TABLE "mira_event_deliveries" ADD CONSTRAINT "mira_event_deliveries_automation_id_mira_automations_id_fkey" FOREIGN KEY ("automation_id") REFERENCES "mira_automations"("id");--> statement-breakpoint
ALTER TABLE "mira_event_deliveries" ADD CONSTRAINT "mira_event_deliveries_run_id_mira_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "mira_runs"("id");--> statement-breakpoint
ALTER TABLE "mira_events" ADD CONSTRAINT "mira_events_task_id_mira_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "mira_tasks"("id");--> statement-breakpoint
ALTER TABLE "mira_messages" ADD CONSTRAINT "mira_messages_conversation_id_mira_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "mira_conversations"("id");--> statement-breakpoint
ALTER TABLE "mira_progress" ADD CONSTRAINT "mira_progress_task_id_mira_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "mira_tasks"("id");--> statement-breakpoint
ALTER TABLE "mira_reports" ADD CONSTRAINT "mira_reports_run_id_mira_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "mira_runs"("id");--> statement-breakpoint
ALTER TABLE "mira_reports" ADD CONSTRAINT "mira_reports_task_id_mira_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "mira_tasks"("id");--> statement-breakpoint
ALTER TABLE "mira_runs" ADD CONSTRAINT "mira_runs_conversation_id_mira_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "mira_conversations"("id");--> statement-breakpoint
ALTER TABLE "mira_runs" ADD CONSTRAINT "mira_runs_user_message_id_mira_messages_id_fkey" FOREIGN KEY ("user_message_id") REFERENCES "mira_messages"("id");--> statement-breakpoint
ALTER TABLE "mira_runs" ADD CONSTRAINT "mira_runs_assistant_message_id_mira_messages_id_fkey" FOREIGN KEY ("assistant_message_id") REFERENCES "mira_messages"("id");--> statement-breakpoint
ALTER TABLE "mira_runs" ADD CONSTRAINT "mira_runs_task_id_mira_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "mira_tasks"("id");--> statement-breakpoint
ALTER TABLE "mira_runs" ADD CONSTRAINT "mira_runs_automation_id_mira_automations_id_fkey" FOREIGN KEY ("automation_id") REFERENCES "mira_automations"("id");--> statement-breakpoint
ALTER TABLE "mira_tasks" ADD CONSTRAINT "mira_tasks_conversation_id_mira_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "mira_conversations"("id");--> statement-breakpoint
ALTER TABLE "mira_tool_receipts" ADD CONSTRAINT "mira_tool_receipts_run_id_mira_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "mira_runs"("id");--> statement-breakpoint
ALTER TABLE "dashboard_notifications" DROP CONSTRAINT "dashboard_notifications_destination", ADD CONSTRAINT "dashboard_notifications_destination" CHECK ("destination" is null or "destination" in ('jobs','applications','infrastructure','alerts','mira','reports'));