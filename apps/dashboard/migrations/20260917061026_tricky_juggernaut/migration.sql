CREATE TABLE "operation_audit" (
	"id" uuid PRIMARY KEY,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_accounts" (
	"id" uuid PRIMARY KEY,
	"label" text NOT NULL,
	"capabilities" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "automation_credentials" (
	"id" uuid PRIMARY KEY,
	"account_id" uuid NOT NULL,
	"prefix" text NOT NULL UNIQUE,
	"digest" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "job_runs" (
	"id" uuid PRIMARY KEY,
	"action" text NOT NULL,
	"label" text NOT NULL,
	"resource_class" text NOT NULL,
	"state" text NOT NULL,
	"payload" jsonb NOT NULL,
	"fingerprint" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"requested_by" text NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"attempt" integer DEFAULT 0 NOT NULL,
	"attempt_limit" integer NOT NULL,
	"retry_safe" boolean NOT NULL,
	"timeout_ms" integer NOT NULL,
	"resource_keys" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"worker_id" uuid,
	"lease_token" uuid,
	"lease_expires_at" timestamp with time zone,
	"cancel_requested" boolean DEFAULT false NOT NULL,
	"message" text,
	CONSTRAINT "job_runs_state" CHECK ("state" in ('queued','running','succeeded','failed','timed_out','cancelled')),
	CONSTRAINT "job_runs_attempts" CHECK ("attempt" >= 0 and "attempt_limit" between 1 and 10 and "timeout_ms" between 1000 and 3600000)
);
--> statement-breakpoint
CREATE TABLE "job_schedules" (
	"id" uuid PRIMARY KEY,
	"action" text NOT NULL UNIQUE,
	"enabled" boolean DEFAULT true NOT NULL,
	"schedule" jsonb NOT NULL,
	"disable_reason" text,
	"disabled_until" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"next_run_at" timestamp with time zone NOT NULL,
	CONSTRAINT "job_schedules_disable_intent" CHECK (("enabled" and "disable_reason" is null and "disabled_until" is null) or (not "enabled" and "disable_reason" is not null and length("disable_reason") between 1 and 1000))
);
--> statement-breakpoint
CREATE TABLE "operation_rate_windows" (
	"key" text PRIMARY KEY,
	"count" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_leases" (
	"key" text PRIMARY KEY,
	"run_id" uuid NOT NULL,
	"lease_token" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operation_snapshots" (
	"key" text PRIMARY KEY,
	"value" jsonb NOT NULL,
	"captured_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "worker_control" (
	"id" integer PRIMARY KEY DEFAULT 1,
	"paused" boolean DEFAULT false NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone,
	"updated_by" text,
	CONSTRAINT "worker_control_singleton" CHECK ("id" = 1)
);
--> statement-breakpoint
CREATE TABLE "workers" (
	"id" uuid PRIMARY KEY,
	"version" text NOT NULL,
	"heartbeat_at" timestamp with time zone NOT NULL,
	"capacity" integer NOT NULL,
	"draining" boolean DEFAULT false NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "operation_audit_target" ON "operation_audit" ("target","id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_runs_idempotency" ON "job_runs" ("idempotency_key");--> statement-breakpoint
CREATE INDEX "job_runs_queue" ON "job_runs" ("state","available_at","priority");--> statement-breakpoint
CREATE INDEX "job_runs_action_history" ON "job_runs" ("action","id");--> statement-breakpoint
ALTER TABLE "automation_credentials" ADD CONSTRAINT "automation_credentials_account_id_automation_accounts_id_fkey" FOREIGN KEY ("account_id") REFERENCES "automation_accounts"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "resource_leases" ADD CONSTRAINT "resource_leases_run_id_job_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "job_runs"("id") ON DELETE CASCADE;
