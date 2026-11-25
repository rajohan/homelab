ALTER TABLE "mira_chat_inputs" ADD COLUMN "source_computer" text;--> statement-breakpoint
ALTER TABLE "mira_runs" ADD COLUMN "source_computer" text;--> statement-breakpoint
ALTER TABLE "mira_computer_access" DROP CONSTRAINT "mira_computer_access_scope", ADD CONSTRAINT "mira_computer_access_scope" CHECK ("scope" IN ('window','desktop','displays'));