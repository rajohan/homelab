ALTER TABLE "job_runs" ADD COLUMN "results" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "reserved_capacity" integer DEFAULT 0 NOT NULL;