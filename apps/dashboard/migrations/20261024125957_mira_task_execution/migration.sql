CREATE TABLE "mira_task_run_reviews" (
	"run_id" uuid PRIMARY KEY,
	"task_id" uuid NOT NULL,
	"owner" text NOT NULL,
	"actor" text NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mira_runs" ADD COLUMN "reviewed_run_id" uuid;--> statement-breakpoint
CREATE INDEX "mira_runs_conversation" ON "mira_runs" ("conversation_id","id");--> statement-breakpoint
CREATE INDEX "mira_runs_task" ON "mira_runs" ("owner","task_id","id");--> statement-breakpoint
CREATE INDEX "mira_runs_reviewed_run" ON "mira_runs" ("reviewed_run_id");--> statement-breakpoint
ALTER TABLE "mira_runs" ADD CONSTRAINT "mira_runs_reviewed_run_id_mira_runs_id_fkey" FOREIGN KEY ("reviewed_run_id") REFERENCES "mira_runs"("id");--> statement-breakpoint
ALTER TABLE "mira_task_run_reviews" ADD CONSTRAINT "mira_task_run_reviews_run_id_mira_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "mira_runs"("id");--> statement-breakpoint
ALTER TABLE "mira_task_run_reviews" ADD CONSTRAINT "mira_task_run_reviews_task_id_mira_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "mira_tasks"("id");