CREATE TABLE "mira_browser_processes" (
	"id" uuid PRIMARY KEY,
	"access_id" uuid NOT NULL,
	"host_id" uuid NOT NULL,
	"image_id" text NOT NULL,
	"lease_token" uuid NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"phase" text DEFAULT 'reserved' NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"container_id" text,
	"cleanup_evidence" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone,
	CONSTRAINT "mira_browser_process_image" CHECK ("image_id" ~ '^sha256:[a-f0-9]{64}$'),
	CONSTRAINT "mira_browser_process_phase" CHECK (("phase" IN ('reserved','creating') AND "container_id" IS NULL) OR ("phase"='created' AND "container_id" IS NOT NULL AND "container_id" ~ '^[a-f0-9]{64}$')),
	CONSTRAINT "mira_browser_process_state" CHECK (("state" IN ('active','cleanup') AND "removed_at" IS NULL AND "cleanup_evidence" IS NULL) OR ("state"='removed' AND "removed_at" IS NOT NULL AND "cleanup_evidence" IS NOT NULL AND (("phase"='reserved' AND "cleanup_evidence"='not-created') OR ("phase"='created' AND "cleanup_evidence" IN ('removed','absent')))))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "mira_browser_process_access" ON "mira_browser_processes" ("access_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mira_browser_process_container" ON "mira_browser_processes" ("host_id","container_id");--> statement-breakpoint
CREATE INDEX "mira_browser_process_recovery" ON "mira_browser_processes" ("host_id","state","lease_expires_at");--> statement-breakpoint
ALTER TABLE "mira_browser_processes" ADD CONSTRAINT "mira_browser_processes_access_id_mira_browser_access_id_fkey" FOREIGN KEY ("access_id") REFERENCES "mira_browser_access"("id");