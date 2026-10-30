CREATE TABLE "mira_browser_consoles" (
	"access_id" uuid PRIMARY KEY,
	"controller" text DEFAULT 'mira' NOT NULL,
	"epoch" uuid NOT NULL,
	"attempts" jsonb DEFAULT '[]' NOT NULL,
	"command_id" uuid,
	"state" text DEFAULT 'idle' NOT NULL,
	"method" text,
	"payload" jsonb,
	"expires_at" timestamp with time zone,
	"frame" jsonb,
	"frame_at" timestamp with time zone,
	CONSTRAINT "mira_browser_console_controller" CHECK ("controller" IN ('mira','human')),
	CONSTRAINT "mira_browser_console_state" CHECK (("state"='idle' AND "payload" IS NULL AND "method" IS NULL AND "expires_at" IS NULL) OR ("state" IN ('queued','claimed') AND "controller"='human' AND "command_id" IS NOT NULL AND "method" IN ('observe','navigate','act') AND "expires_at" IS NOT NULL AND (("state"='queued' AND "payload" IS NOT NULL) OR ("state"='claimed' AND "payload" IS NULL)))),
	CONSTRAINT "mira_browser_console_size" CHECK (("payload" IS NULL OR octet_length("payload"::text)<=32768) AND ("frame" IS NULL OR octet_length("frame"::text)<=4194304) AND jsonb_typeof("attempts")='array' AND jsonb_array_length("attempts")<=128),
	CONSTRAINT "mira_browser_console_frame" CHECK (("frame" IS NULL) = ("frame_at" IS NULL))
);
--> statement-breakpoint
ALTER TABLE "mira_browser_consoles" ADD CONSTRAINT "mira_browser_consoles_access_id_mira_browser_access_id_fkey" FOREIGN KEY ("access_id") REFERENCES "mira_browser_access"("id");
--> statement-breakpoint
INSERT INTO mira_browser_consoles (access_id, epoch) SELECT id, gen_random_uuid() FROM mira_browser_access WHERE state IN ('pending', 'active');
