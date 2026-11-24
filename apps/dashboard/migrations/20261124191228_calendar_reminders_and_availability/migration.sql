CREATE TABLE "availability_backfill" (
	"kind" text,
	"resource" text,
	"next_day" integer NOT NULL,
	CONSTRAINT "availability_backfill_pkey" PRIMARY KEY("kind","resource")
);
--> statement-breakpoint
CREATE TABLE "availability_days" (
	"kind" text,
	"resource" text,
	"day" integer,
	"first_minute" integer NOT NULL,
	"observed" bit(1440) NOT NULL,
	"healthy" bit(1440) NOT NULL,
	CONSTRAINT "availability_days_pkey" PRIMARY KEY("kind","resource","day")
);
--> statement-breakpoint
ALTER TABLE "mira_calendar_events" ADD COLUMN "operator_reminder_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mira_calendar_events" ADD COLUMN "operator_reminded_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mira_calendar_events" ADD COLUMN "mira_reminder_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mira_calendar_events" ADD COLUMN "mira_reminder_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "mira_calendar_events" ADD COLUMN "mira_reminder_run_id" uuid;--> statement-breakpoint
CREATE INDEX "mira_calendar_operator_due" ON "mira_calendar_events" ("operator_reminder_at","id") WHERE "operator_reminder_at" is not null and "operator_reminded_at" is null;--> statement-breakpoint
CREATE INDEX "mira_calendar_mira_due" ON "mira_calendar_events" ("mira_reminder_at","id") WHERE "mira_reminder_at" is not null and "mira_reminder_run_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "mira_calendar_reminder_run" ON "mira_calendar_events" ("mira_reminder_run_id") WHERE "mira_reminder_run_id" is not null;--> statement-breakpoint
ALTER TABLE "dashboard_notifications" DROP CONSTRAINT "dashboard_notifications_destination", ADD CONSTRAINT "dashboard_notifications_destination" CHECK ("destination" is null or "destination" in ('jobs','applications','infrastructure','alerts','mira','reports','calendar'));