CREATE TABLE "mira_computers" (
	"id" uuid PRIMARY KEY,
	"owner" text NOT NULL,
	"label" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"state" text NOT NULL,
	"pair_digest" text,
	"credential_digest" text,
	"installation_id" uuid,
	"platform" text,
	"companion_version" text,
	"paired_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"connection_id" uuid,
	"connection_expires_at" timestamp with time zone,
	"sequence" integer DEFAULT 0 NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "mira_computers_version" CHECK ("version" > 0 AND "sequence" >= 0),
	CONSTRAINT "mira_computers_label" CHECK (length("label") BETWEEN 1 AND 80),
	CONSTRAINT "mira_computers_platform" CHECK ("platform" IS NULL OR "platform" IN ('win32','linux','darwin')),
	CONSTRAINT "mira_computers_credential_state" CHECK (
        ("state"='pending' AND "pair_digest" IS NOT NULL AND "credential_digest" IS NULL AND "paired_at" IS NULL) OR
        ("state"='paired' AND "pair_digest" IS NULL AND "credential_digest" IS NOT NULL AND "paired_at" IS NOT NULL AND "installation_id" IS NOT NULL AND "platform" IS NOT NULL AND "companion_version" IS NOT NULL) OR
        ("state"='revoked' AND "pair_digest" IS NULL AND "credential_digest" IS NULL)),
	CONSTRAINT "mira_computers_connection" CHECK (("connection_id" IS NULL AND "connection_expires_at" IS NULL) OR ("state"='paired' AND "connection_id" IS NOT NULL AND "connection_expires_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX "mira_computers_owner" ON "mira_computers" ("owner","created_at","id");