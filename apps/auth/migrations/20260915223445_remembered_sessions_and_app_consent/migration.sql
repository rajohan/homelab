CREATE TABLE "auth_oidc_approvals" (
	"user_id" uuid,
	"client_id" text,
	"client_name" text NOT NULL,
	"fingerprint" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"approved_at" timestamp with time zone NOT NULL,
	CONSTRAINT "auth_oidc_approvals_pkey" PRIMARY KEY("user_id","client_id")
);
--> statement-breakpoint
ALTER TABLE "auth_grant_sessions" ADD COLUMN "client_id" text;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD COLUMN "remember" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_oidc_approvals" ADD CONSTRAINT "auth_oidc_approvals_user_id_auth_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "auth_users"("id") ON DELETE CASCADE;