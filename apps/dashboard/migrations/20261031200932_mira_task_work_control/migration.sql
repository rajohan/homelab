ALTER TABLE "mira_runs" ADD COLUMN "task_change_id" uuid;--> statement-breakpoint
ALTER TABLE "mira_runs" ADD COLUMN "task_resumed" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mira_tasks" ADD COLUMN "work_stopped_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "mira_audit_task_work_started" ON "mira_audit" ("owner","target") WHERE "actor" = 'human:' || "owner" and "action" = 'task.run_requested';--> statement-breakpoint
CREATE INDEX "mira_audit_task_work_recent" ON "mira_audit" ("created_at") WHERE "actor" = 'human:' || "owner" and "action" in ('task.resume_requested','task.updated','task.progress_added');--> statement-breakpoint
CREATE INDEX "mira_audit_task_work_latest" ON "mira_audit" ("owner","target","id" DESC NULLS LAST) WHERE "actor" = 'human:' || "owner" and "action" in ('task.created','task.updated','task.progress_added');