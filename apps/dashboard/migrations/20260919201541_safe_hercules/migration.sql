CREATE TABLE "operational_incidents" (
	"id" uuid PRIMARY KEY,
	"source_key" text NOT NULL UNIQUE,
	"name" text NOT NULL,
	"host" text,
	"service" text,
	"severity" text NOT NULL,
	"state" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"resolved_at" timestamp with time zone,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "operational_incidents_state" CHECK ("state" in ('active','suppressed','resolved')),
	CONSTRAINT "operational_incidents_severity" CHECK ("severity" in ('info','warning','error'))
);
--> statement-breakpoint
CREATE INDEX "operational_incidents_state_id" ON "operational_incidents" ("state","id");--> statement-breakpoint
CREATE INDEX "operational_incidents_resolution" ON "operational_incidents" ("state","resolved_at" DESC,"id" DESC);--> statement-breakpoint
ALTER TABLE "dashboard_notifications" DROP CONSTRAINT "dashboard_notifications_destination", ADD CONSTRAINT "dashboard_notifications_destination" CHECK ("destination" is null or "destination" in ('jobs','applications','infrastructure','alerts'));
