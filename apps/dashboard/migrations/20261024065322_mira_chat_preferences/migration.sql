ALTER TABLE "mira_conversations" ADD COLUMN "settings" jsonb DEFAULT '{"model":null,"effort":null,"serviceTier":null}' NOT NULL;--> statement-breakpoint
ALTER TABLE "mira_runs" ADD COLUMN "settings" jsonb DEFAULT '{"model":null,"effort":null,"serviceTier":null}' NOT NULL;--> statement-breakpoint
ALTER TABLE "mira_runtime_status" ADD COLUMN "models" jsonb DEFAULT '[]' NOT NULL;