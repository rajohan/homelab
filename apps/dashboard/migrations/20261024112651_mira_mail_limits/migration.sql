ALTER TABLE "mira_events" ADD COLUMN "received_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "mira_events_run" ON "mira_event_deliveries" ("run_id");--> statement-breakpoint
CREATE INDEX "mira_events_received_owner" ON "mira_events" ("owner","kind","received_at");--> statement-breakpoint
CREATE INDEX "mira_events_received_cleanup" ON "mira_events" ("kind","received_at");