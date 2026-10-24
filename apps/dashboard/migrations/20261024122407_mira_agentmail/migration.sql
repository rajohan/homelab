CREATE TABLE "mira_control_windows" (
	"owner" text,
	"key" text,
	"version" integer,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "mira_control_windows_pkey" PRIMARY KEY("owner","key","version")
);
--> statement-breakpoint
CREATE TABLE "mira_integration_receivers" (
	"key" text PRIMARY KEY,
	"binding_hash" text,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mira_integration_state" (
	"owner" text,
	"key" text,
	"binding" text NOT NULL,
	"control_version" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_through" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone,
	"cursor" text,
	"event_anchor" text,
	"window_head" text,
	"pending_scans" jsonb DEFAULT '[]' NOT NULL,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"last_success_at" timestamp with time zone,
	"message" text,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mira_integration_state_pkey" PRIMARY KEY("owner","key")
);
--> statement-breakpoint
ALTER TABLE "mira_events" ADD COLUMN "received_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "mira_events" ADD COLUMN "eligibility_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mira_runtime_status" ADD COLUMN "integrations" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "mira_switches" ADD COLUMN "changed_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "mira_switches" ADD COLUMN "binding_hash" text;--> statement-breakpoint
ALTER TABLE "mira_switches" ADD COLUMN "binding_activated_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "mira_control_windows_eligibility" ON "mira_control_windows" ("owner","key","started_at");--> statement-breakpoint
CREATE INDEX "mira_events_run" ON "mira_event_deliveries" ("run_id");--> statement-breakpoint
CREATE INDEX "mira_events_received_owner" ON "mira_events" ("owner","kind","received_at");--> statement-breakpoint
CREATE INDEX "mira_events_received_cleanup" ON "mira_events" ("kind","received_at");
--> statement-breakpoint
INSERT INTO "mira_control_windows" ("owner", "key", "version", "started_at") SELECT "owner", "key", "version", "changed_at" FROM "mira_switches" WHERE "enabled";
--> statement-breakpoint
UPDATE "mira_switches" s SET "binding_activated_at"=COALESCE((SELECT max(w.started_at) FROM mira_control_windows w WHERE w.owner=s.owner AND w.key=s.key),s.changed_at) WHERE s.key='integration:agentmail' AND s.binding_hash IS NOT NULL;
