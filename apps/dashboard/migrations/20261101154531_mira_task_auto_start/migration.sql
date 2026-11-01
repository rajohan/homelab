ALTER TABLE "mira_runs" ADD COLUMN "task_auto_started" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mira_tasks" ADD COLUMN "auto_start" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mira_tasks" ADD COLUMN "auto_start_revoked_at" timestamp with time zone;--> statement-breakpoint
DROP INDEX "mira_audit_task_work_started";--> statement-breakpoint
CREATE INDEX "mira_audit_task_work_started" ON "mira_audit" ("owner","target") WHERE ("actor" = 'human:' || "owner" and "action" = 'task.run_requested') or ("actor" = 'mira:scheduler' and "action" = 'task.auto_started');--> statement-breakpoint
DROP INDEX "mira_audit_task_work_recent";--> statement-breakpoint
CREATE INDEX "mira_audit_task_work_recent" ON "mira_audit" ("created_at") WHERE "actor" = 'human:' || "owner" and "action" in ('task.auto_start_requested','task.resume_requested','task.updated','task.progress_added');