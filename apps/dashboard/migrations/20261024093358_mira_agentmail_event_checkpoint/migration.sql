CREATE TABLE "mira_integration_receivers" (
	"key" text PRIMARY KEY,
	"binding_hash" text,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mira_integration_state" ADD COLUMN "event_anchor" text;--> statement-breakpoint
ALTER TABLE "mira_integration_state" ADD COLUMN "window_head" text;