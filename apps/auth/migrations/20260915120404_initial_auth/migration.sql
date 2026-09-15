CREATE TABLE "auth_audit_events" (
	"id" uuid PRIMARY KEY,
	"user_id" uuid,
	"event" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_challenges" (
	"digest" text PRIMARY KEY,
	"user_id" uuid NOT NULL,
	"session_id" uuid,
	"purpose" text NOT NULL,
	"encrypted_data" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_factors" (
	"id" uuid PRIMARY KEY,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"label" text NOT NULL,
	"credential_id" text UNIQUE,
	"encrypted_data" text NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "auth_grant_sessions" (
	"grant_id" text PRIMARY KEY,
	"encrypted_logout" text,
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_logout_outbox" (
	"id" text PRIMARY KEY,
	"encrypted_data" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_mail_outbox" (
	"id" uuid PRIMARY KEY,
	"proof_digest" text,
	"encrypted_data" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"next_attempt_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"sent_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "auth_oidc_records" (
	"digest" text PRIMARY KEY,
	"model" text NOT NULL,
	"encrypted_data" text NOT NULL,
	"grant_id" text,
	"uid" text,
	"user_code" text,
	"consumed_at" integer,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_rate_buckets" (
	"digest" text PRIMARY KEY,
	"attempts" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_recovery_codes" (
	"user_id" uuid,
	"digest" text,
	CONSTRAINT "auth_recovery_codes_pkey" PRIMARY KEY("user_id","digest")
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" uuid PRIMARY KEY,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL UNIQUE,
	"created_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"password_at" timestamp with time zone NOT NULL,
	"mfa_at" timestamp with time zone,
	"user_agent" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_users" (
	"id" uuid PRIMARY KEY,
	"username" text NOT NULL UNIQUE,
	"email" text NOT NULL UNIQUE,
	"email_verified" boolean DEFAULT false NOT NULL,
	"password_hash" text NOT NULL,
	"groups" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "auth_audit_user_time_idx" ON "auth_audit_events" ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "auth_challenges_expiry_idx" ON "auth_challenges" ("expires_at");--> statement-breakpoint
CREATE INDEX "auth_factors_user_idx" ON "auth_factors" ("user_id");--> statement-breakpoint
CREATE INDEX "auth_oidc_grant_idx" ON "auth_oidc_records" ("grant_id");--> statement-breakpoint
CREATE INDEX "auth_oidc_uid_idx" ON "auth_oidc_records" ("uid");--> statement-breakpoint
CREATE INDEX "auth_oidc_expiry_idx" ON "auth_oidc_records" ("expires_at");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_idx" ON "auth_sessions" ("user_id");--> statement-breakpoint
ALTER TABLE "auth_audit_events" ADD CONSTRAINT "auth_audit_events_user_id_auth_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth_users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "auth_challenges" ADD CONSTRAINT "auth_challenges_user_id_auth_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth_users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth_challenges" ADD CONSTRAINT "auth_challenges_session_id_auth_sessions_id_fkey" FOREIGN KEY ("session_id") REFERENCES "auth_sessions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth_factors" ADD CONSTRAINT "auth_factors_user_id_auth_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth_users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth_grant_sessions" ADD CONSTRAINT "auth_grant_sessions_session_id_auth_sessions_id_fkey" FOREIGN KEY ("session_id") REFERENCES "auth_sessions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth_grant_sessions" ADD CONSTRAINT "auth_grant_sessions_user_id_auth_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth_users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth_mail_outbox" ADD CONSTRAINT "auth_mail_outbox_proof_digest_auth_challenges_digest_fkey" FOREIGN KEY ("proof_digest") REFERENCES "auth_challenges"("digest") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth_recovery_codes" ADD CONSTRAINT "auth_recovery_codes_user_id_auth_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth_users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_auth_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth_users"("id") ON DELETE CASCADE;