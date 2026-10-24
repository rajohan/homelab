ALTER TABLE "mira_runs" ADD COLUMN "reviewed_run_id" uuid;--> statement-breakpoint
CREATE INDEX "mira_runs_reviewed_run" ON "mira_runs" ("reviewed_run_id");--> statement-breakpoint
ALTER TABLE "mira_runs" ADD CONSTRAINT "mira_runs_reviewed_run_id_mira_runs_id_fkey" FOREIGN KEY ("reviewed_run_id") REFERENCES "mira_runs"("id");