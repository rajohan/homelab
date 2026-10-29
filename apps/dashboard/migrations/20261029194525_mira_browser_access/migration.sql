CREATE TABLE "mira_browser_access" (
	"id" uuid PRIMARY KEY,
	"owner" text NOT NULL,
	"run_id" uuid NOT NULL,
	"run_lease" uuid NOT NULL,
	"controls" jsonb NOT NULL,
	"mode" text NOT NULL,
	"policy" jsonb,
	"state" text DEFAULT 'pending' NOT NULL,
	"host_token" uuid,
	"claimed_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mira_browser_access_mode" CHECK ("mode" IN ('view','control')),
	CONSTRAINT "mira_browser_access_state" CHECK (("state"='pending' AND "host_token" IS NULL AND "claimed_at" IS NULL AND "closed_at" IS NULL AND "policy" IS NOT NULL) OR ("state"='active' AND "host_token" IS NOT NULL AND "claimed_at" IS NOT NULL AND "closed_at" IS NULL AND "policy" IS NOT NULL) OR ("state"='stopping' AND "host_token" IS NOT NULL AND "claimed_at" IS NOT NULL AND "closed_at" IS NULL AND "policy" IS NULL) OR ("state"='closed' AND "closed_at" IS NOT NULL AND "policy" IS NULL)),
	CONSTRAINT "mira_browser_access_duration" CHECK ("expires_at">"created_at" AND "expires_at"<="created_at"+interval '5 minutes'),
	CONSTRAINT "mira_browser_access_policy_size" CHECK ("policy" IS NULL OR octet_length("policy"::text)<=131072)
);
--> statement-breakpoint
CREATE INDEX "mira_browser_access_history" ON "mira_browser_access" ("owner","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "mira_browser_access_owner" ON "mira_browser_access" ("owner") WHERE "state"<>'closed';--> statement-breakpoint
ALTER TABLE "mira_browser_access" ADD CONSTRAINT "mira_browser_access_run_id_mira_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "mira_runs"("id");