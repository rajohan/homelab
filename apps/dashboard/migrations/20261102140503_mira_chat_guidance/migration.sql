CREATE TABLE "mira_chat_inputs" (
	"id" uuid PRIMARY KEY,
	"owner" text NOT NULL,
	"conversation_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"request_key" text NOT NULL UNIQUE,
	"request_hash" text NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"lease_token" uuid,
	CONSTRAINT "mira_chat_inputs_state" CHECK ("state" IN ('pending','sending','delivered','continued','stopped'))
);
--> statement-breakpoint
ALTER TABLE "mira_messages" ADD COLUMN "parts" jsonb DEFAULT '[]' NOT NULL;--> statement-breakpoint
CREATE INDEX "mira_chat_inputs_pending" ON "mira_chat_inputs" ("state","id");--> statement-breakpoint
CREATE INDEX "mira_chat_inputs_conversation" ON "mira_chat_inputs" ("conversation_id","id");--> statement-breakpoint
ALTER TABLE "mira_chat_inputs" ADD CONSTRAINT "mira_chat_inputs_id_mira_messages_id_fkey" FOREIGN KEY ("id") REFERENCES "mira_messages"("id");--> statement-breakpoint
ALTER TABLE "mira_chat_inputs" ADD CONSTRAINT "mira_chat_inputs_conversation_id_mira_conversations_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "mira_conversations"("id");--> statement-breakpoint
ALTER TABLE "mira_chat_inputs" ADD CONSTRAINT "mira_chat_inputs_run_id_mira_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "mira_runs"("id");