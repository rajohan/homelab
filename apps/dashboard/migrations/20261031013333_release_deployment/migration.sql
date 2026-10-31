CREATE TABLE "release_deployments" (
	"id" uuid PRIMARY KEY,
	"target" text NOT NULL,
	"requested_by" text NOT NULL,
	"request_key" text NOT NULL UNIQUE,
	"confirmation_revision" text NOT NULL,
	"configuration" text NOT NULL,
	"plan" jsonb NOT NULL,
	"state" text NOT NULL,
	"phase" text NOT NULL,
	"message" text,
	"receipt" jsonb,
	"controller" uuid,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	CONSTRAINT "release_deployments_state" CHECK ("state" in ('waiting','submitting','running','succeeded','failed','cancelled','unknown')),
	CONSTRAINT "release_deployments_completion" CHECK (("state" in ('succeeded','cancelled') and "finished_at" is not null) or ("state" in ('waiting','submitting','running','unknown') and "finished_at" is null) or "state" = 'failed'),
	CONSTRAINT "release_deployments_lease" CHECK (("controller" is null and "lease_token" is null and "lease_expires_at" is null) or ("controller" is not null and "lease_token" is not null and "lease_expires_at" is not null)),
	CONSTRAINT "release_deployments_configuration" CHECK ("configuration" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "release_deployments_message" CHECK ("message" is null or length("message") between 1 and 500)
);
--> statement-breakpoint
ALTER TABLE "mira_runtime_status" ADD COLUMN "deployment_drained_for" uuid;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "deployment_protocol" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workers" ADD COLUMN "deployment_drained_for" uuid;--> statement-breakpoint
CREATE UNIQUE INDEX "release_deployments_active" ON "release_deployments" ((true)) WHERE "finished_at" is null;--> statement-breakpoint
CREATE INDEX "release_deployments_history" ON "release_deployments" ("id" DESC NULLS LAST);