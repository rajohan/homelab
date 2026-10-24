CREATE TABLE "mira_integration_state" (
	"owner" text,
	"key" text,
	"binding" text NOT NULL,
	"control_version" integer NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"completed_through" timestamp with time zone NOT NULL,
	"window_end" timestamp with time zone,
	"cursor" text,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"last_success_at" timestamp with time zone,
	"message" text,
	"heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mira_integration_state_pkey" PRIMARY KEY("owner","key")
);
--> statement-breakpoint
ALTER TABLE "mira_runtime_status" ADD COLUMN "integrations" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE "mira_switches" ADD COLUMN "changed_at" timestamp with time zone DEFAULT now() NOT NULL;