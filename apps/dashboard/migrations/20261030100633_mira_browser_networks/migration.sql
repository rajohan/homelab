ALTER TABLE "mira_browser_processes" ADD COLUMN "network_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "mira_browser_process_network" ON "mira_browser_processes" ("host_id","network_id") WHERE "state" <> 'removed';--> statement-breakpoint
ALTER TABLE "mira_browser_processes" ADD CONSTRAINT "mira_browser_process_network_id" CHECK ("network_id" IS NULL OR "network_id" ~ '^[a-f0-9]{64}$');