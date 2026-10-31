CREATE TABLE "release_deployment_policies" (
	"target" text PRIMARY KEY,
	"version" integer DEFAULT 1 NOT NULL,
	"configuration" text NOT NULL,
	"mode" text DEFAULT 'manual' NOT NULL,
	"window" jsonb NOT NULL,
	"time_zone" text NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"disable_reason" text,
	"disabled_until" timestamp with time zone,
	"updated_by" text NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "release_deployment_policies_version" CHECK ("version">0),
	CONSTRAINT "release_deployment_policies_mode" CHECK ("mode" in ('manual','patch','minor')),
	CONSTRAINT "release_deployment_policies_configuration" CHECK ("configuration" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "release_deployment_policies_pause" CHECK (("paused" and "disable_reason" is not null and length("disable_reason") between 1 and 1000) or (not "paused" and "disable_reason" is null and "disabled_until" is null))
);
--> statement-breakpoint
ALTER TABLE "release_deployments" ADD COLUMN "policy_version" integer;--> statement-breakpoint
ALTER TABLE "release_deployments" ADD COLUMN "window_ends_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "release_deployments" ADD CONSTRAINT "release_deployments_automatic" CHECK (("policy_version" is null and "window_ends_at" is null) or ("policy_version" is not null and "policy_version">0 and "window_ends_at" is not null));