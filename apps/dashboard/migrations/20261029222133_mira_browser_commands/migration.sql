CREATE TABLE "mira_browser_commands" (
	"id" uuid PRIMARY KEY,
	"owner" text NOT NULL,
	"access_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"run_lease" uuid NOT NULL,
	"process_id" uuid,
	"process_token" uuid,
	"method" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"payload" jsonb,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "mira_browser_commands_method" CHECK ("method" IN ('observe','navigate','act')),
	CONSTRAINT "mira_browser_commands_state" CHECK ("state" IN ('queued','claimed','completed','consumed','refused','unknown')),
	CONSTRAINT "mira_browser_commands_duration" CHECK ("expires_at">"created_at" AND "expires_at"<="created_at"+interval '100 seconds'),
	CONSTRAINT "mira_browser_commands_binding" CHECK (("process_id" IS NULL AND "process_token" IS NULL AND "state" IN ('queued','refused','unknown')) OR ("process_id" IS NOT NULL AND "process_token" IS NOT NULL AND "state"<>'queued')),
	CONSTRAINT "mira_browser_commands_payload" CHECK (("state"='queued' AND "payload" IS NOT NULL AND "result" IS NULL) OR ("state"='claimed' AND "payload" IS NULL AND "result" IS NULL) OR ("state"='completed' AND "payload" IS NULL AND "result" IS NOT NULL) OR ("state" IN ('consumed','refused','unknown') AND "payload" IS NULL AND "result" IS NULL)),
	CONSTRAINT "mira_browser_commands_size" CHECK (("payload" IS NULL OR octet_length("payload"::text)<=32768) AND ("result" IS NULL OR octet_length("result"::text)<=4194304))
);
--> statement-breakpoint
CREATE INDEX "mira_browser_commands_owner" ON "mira_browser_commands" ("owner","state");--> statement-breakpoint
CREATE INDEX "mira_browser_commands_cleanup" ON "mira_browser_commands" ("state","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mira_browser_commands_active" ON "mira_browser_commands" ("access_id") WHERE "state" IN ('queued','claimed','completed');--> statement-breakpoint
ALTER TABLE "mira_browser_commands" ADD CONSTRAINT "mira_browser_commands_id_mira_tool_receipts_id_fkey" FOREIGN KEY ("id") REFERENCES "mira_tool_receipts"("id");--> statement-breakpoint
ALTER TABLE "mira_browser_commands" ADD CONSTRAINT "mira_browser_commands_access_id_mira_browser_access_id_fkey" FOREIGN KEY ("access_id") REFERENCES "mira_browser_access"("id");--> statement-breakpoint
ALTER TABLE "mira_browser_commands" ADD CONSTRAINT "mira_browser_commands_run_id_mira_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "mira_runs"("id");--> statement-breakpoint
ALTER TABLE "mira_browser_commands" ADD CONSTRAINT "mira_browser_commands_process_id_mira_browser_processes_id_fkey" FOREIGN KEY ("process_id") REFERENCES "mira_browser_processes"("id");