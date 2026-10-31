CREATE TABLE "mira_task_continuation_cursor" (
	"id" integer PRIMARY KEY DEFAULT 1,
	"after_id" uuid NOT NULL,
	CONSTRAINT "mira_task_continuation_cursor_singleton" CHECK ("id" = 1)
);
