CREATE TABLE "mira_computer_commands" (
	"id" uuid PRIMARY KEY,
	"owner" text NOT NULL,
	"access_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"run_lease" uuid NOT NULL,
	"connection_id" uuid NOT NULL,
	"target_id" uuid NOT NULL,
	"action" text NOT NULL,
	"state" text DEFAULT 'queued' NOT NULL,
	"payload" jsonb,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	CONSTRAINT "mira_computer_commands_action" CHECK ("action" IN ('observe','click','type')),
	CONSTRAINT "mira_computer_commands_state" CHECK ("state" IN ('queued','claimed','completed','consumed','refused','unknown')),
	CONSTRAINT "mira_computer_commands_duration" CHECK ("expires_at">"created_at" AND "expires_at"<="created_at"+interval '15 seconds'),
	CONSTRAINT "mira_computer_commands_payload" CHECK (("state"='queued' AND "payload" IS NOT NULL AND "result" IS NULL) OR ("state"='claimed' AND "payload" IS NULL AND "result" IS NULL) OR ("state"='completed' AND "payload" IS NULL AND "result" IS NOT NULL) OR ("state" IN ('consumed','refused','unknown') AND "payload" IS NULL AND "result" IS NULL)),
	CONSTRAINT "mira_computer_commands_size" CHECK (("payload" IS NULL OR octet_length("payload"::text)<=32768) AND ("result" IS NULL OR octet_length("result"::text)<=3145728))
);
--> statement-breakpoint
CREATE INDEX "mira_computer_commands_owner" ON "mira_computer_commands" ("owner","state");--> statement-breakpoint
CREATE INDEX "mira_computer_commands_access" ON "mira_computer_commands" ("access_id");--> statement-breakpoint
CREATE INDEX "mira_computer_commands_cleanup" ON "mira_computer_commands" ("state","expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "mira_computer_commands_active" ON "mira_computer_commands" ("access_id") WHERE "state" IN ('queued','claimed','completed');--> statement-breakpoint
ALTER TABLE "mira_computer_commands" ADD CONSTRAINT "mira_computer_commands_id_mira_tool_receipts_id_fkey" FOREIGN KEY ("id") REFERENCES "mira_tool_receipts"("id");--> statement-breakpoint
ALTER TABLE "mira_computer_commands" ADD CONSTRAINT "mira_computer_commands_access_id_mira_computer_access_id_fkey" FOREIGN KEY ("access_id") REFERENCES "mira_computer_access"("id");--> statement-breakpoint
ALTER TABLE "mira_computer_commands" ADD CONSTRAINT "mira_computer_commands_run_id_mira_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "mira_runs"("id");