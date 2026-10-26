CREATE TABLE "mira_computer_access" (
	"id" uuid PRIMARY KEY,
	"owner" text NOT NULL,
	"computer_id" uuid NOT NULL,
	"computer_version" integer NOT NULL,
	"connection_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"run_lease" uuid NOT NULL,
	"controls" jsonb NOT NULL,
	"mode" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"target_id" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"stopped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mira_computer_access_mode" CHECK ("mode" IN ('view','control')),
	CONSTRAINT "mira_computer_access_state" CHECK (("state"='pending' AND "target_id" IS NULL AND "accepted_at" IS NULL AND "stopped_at" IS NULL) OR ("state"='active' AND "target_id" IS NOT NULL AND "accepted_at" IS NOT NULL AND "stopped_at" IS NULL) OR ("state"='stopped' AND "stopped_at" IS NOT NULL)),
	CONSTRAINT "mira_computer_access_duration" CHECK ("expires_at" > "created_at" AND "expires_at" <= "created_at"+interval '5 minutes')
);
--> statement-breakpoint
CREATE INDEX "mira_computer_access_owner" ON "mira_computer_access" ("owner","created_at","id");--> statement-breakpoint
CREATE UNIQUE INDEX "mira_computer_access_computer" ON "mira_computer_access" ("computer_id") WHERE "state" IN ('pending','active');--> statement-breakpoint
CREATE UNIQUE INDEX "mira_computer_access_run" ON "mira_computer_access" ("run_id") WHERE "state" IN ('pending','active');--> statement-breakpoint
ALTER TABLE "mira_computer_access" ADD CONSTRAINT "mira_computer_access_computer_id_mira_computers_id_fkey" FOREIGN KEY ("computer_id") REFERENCES "mira_computers"("id");--> statement-breakpoint
ALTER TABLE "mira_computer_access" ADD CONSTRAINT "mira_computer_access_run_id_mira_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "mira_runs"("id");