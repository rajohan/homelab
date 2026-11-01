ALTER TABLE "mira_code_publications" ADD COLUMN "approval_run_id" uuid;--> statement-breakpoint
ALTER TABLE "mira_daytona_jobs" ADD COLUMN "approval_run_id" uuid;--> statement-breakpoint
ALTER TABLE "mira_mail_drafts" ADD COLUMN "approval_run_id" uuid;--> statement-breakpoint
ALTER TABLE "mira_publications" ADD COLUMN "approval_run_id" uuid;--> statement-breakpoint
ALTER TABLE "mira_runs" ADD COLUMN "approval_revoked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mira_social_drafts" ADD COLUMN "approval_run_id" uuid;--> statement-breakpoint
ALTER TABLE "mira_code_publications" ADD CONSTRAINT "mira_code_publications_approval_run_id_mira_runs_id_fkey" FOREIGN KEY ("approval_run_id") REFERENCES "mira_runs"("id");--> statement-breakpoint
ALTER TABLE "mira_daytona_jobs" ADD CONSTRAINT "mira_daytona_jobs_approval_run_id_mira_runs_id_fkey" FOREIGN KEY ("approval_run_id") REFERENCES "mira_runs"("id");--> statement-breakpoint
ALTER TABLE "mira_mail_drafts" ADD CONSTRAINT "mira_mail_drafts_approval_run_id_mira_runs_id_fkey" FOREIGN KEY ("approval_run_id") REFERENCES "mira_runs"("id");--> statement-breakpoint
ALTER TABLE "mira_publications" ADD CONSTRAINT "mira_publications_approval_run_id_mira_runs_id_fkey" FOREIGN KEY ("approval_run_id") REFERENCES "mira_runs"("id");--> statement-breakpoint
ALTER TABLE "mira_social_drafts" ADD CONSTRAINT "mira_social_drafts_approval_run_id_mira_runs_id_fkey" FOREIGN KEY ("approval_run_id") REFERENCES "mira_runs"("id");