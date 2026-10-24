CREATE TABLE "mira_control_windows" (
	"owner" text,
	"key" text,
	"version" integer,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "mira_control_windows_pkey" PRIMARY KEY("owner","key","version")
);
--> statement-breakpoint
ALTER TABLE "mira_switches" ADD COLUMN "binding_hash" text;--> statement-breakpoint
CREATE INDEX "mira_control_windows_eligibility" ON "mira_control_windows" ("owner","key","started_at");
--> statement-breakpoint
INSERT INTO "mira_control_windows" ("owner", "key", "version", "started_at") SELECT "owner", "key", "version", "changed_at" FROM "mira_switches" WHERE "enabled";
