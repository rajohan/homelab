CREATE TABLE "notification_receipts" (
	"notification_id" uuid,
	"actor" text,
	"read_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	CONSTRAINT "notification_receipts_pkey" PRIMARY KEY("notification_id","actor")
);
--> statement-breakpoint
CREATE TABLE "dashboard_notifications" (
	"id" uuid PRIMARY KEY,
	"publication_order" bigint GENERATED ALWAYS AS IDENTITY (sequence name "dashboard_notifications_publication_order_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"source" text NOT NULL,
	"source_key" text NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"severity" text NOT NULL,
	"destination" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dashboard_notifications_severity" CHECK ("severity" in ('info','success','warning','error')),
	CONSTRAINT "dashboard_notifications_destination" CHECK ("destination" is null or "destination" in ('jobs','applications','infrastructure'))
);
--> statement-breakpoint
ALTER TABLE "operation_audit" ADD COLUMN "message" text;--> statement-breakpoint
CREATE INDEX "notification_receipts_actor" ON "notification_receipts" ("actor","notification_id");--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_notifications_source_key" ON "dashboard_notifications" ("source","source_key");--> statement-breakpoint
CREATE UNIQUE INDEX "dashboard_notifications_publication_order" ON "dashboard_notifications" ("publication_order");--> statement-breakpoint
CREATE INDEX "dashboard_notifications_severity_id" ON "dashboard_notifications" ("severity","id");--> statement-breakpoint
ALTER TABLE "notification_receipts" ADD CONSTRAINT "notification_receipts_oGiQHPWc6eZn_fkey" FOREIGN KEY ("notification_id") REFERENCES "dashboard_notifications"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "operation_audit" ADD CONSTRAINT "operation_audit_message_length" CHECK ("message" is null or length("message") between 1 and 500);
