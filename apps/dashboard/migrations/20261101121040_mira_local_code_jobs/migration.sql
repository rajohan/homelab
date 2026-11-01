ALTER TABLE "mira_daytona_jobs" ADD COLUMN "execution_target" text DEFAULT 'daytona' NOT NULL;--> statement-breakpoint
ALTER TABLE "mira_daytona_jobs" ADD COLUMN "local_container_id" text;--> statement-breakpoint
ALTER TABLE "mira_daytona_jobs" ADD COLUMN "local_creation_settled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "mira_daytona_jobs" ADD CONSTRAINT "mira_code_target" CHECK ("execution_target" IN ('daytona','main'));--> statement-breakpoint
ALTER TABLE "mira_daytona_jobs" ADD CONSTRAINT "mira_code_local_receipt" CHECK (("local_container_id" IS NULL OR "local_container_id" ~ '^[a-f0-9]{64}$') AND ("execution_target"='main' OR ("local_container_id" IS NULL AND NOT "local_creation_settled")));