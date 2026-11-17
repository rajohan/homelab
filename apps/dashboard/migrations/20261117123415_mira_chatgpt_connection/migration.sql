CREATE TABLE "mira_chatgpt_login" (
	"id" integer PRIMARY KEY DEFAULT 1,
	"request_id" uuid NOT NULL,
	"owner" text NOT NULL,
	"state" text NOT NULL,
	"worker_id" uuid,
	"verification_url" text,
	"user_code" text,
	"message" text,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "mira_chatgpt_login_singleton" CHECK ("id"=1),
	CONSTRAINT "mira_chatgpt_login_state" CHECK ("state" in ('requested','starting','waiting','completed','failed','cancelled'))
);
--> statement-breakpoint
ALTER TABLE "mira_runtime_status" ADD COLUMN "chatgpt" jsonb;