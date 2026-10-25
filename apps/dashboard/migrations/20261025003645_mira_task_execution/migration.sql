CREATE TABLE "mira_task_run_reviews" (
	"run_id" uuid PRIMARY KEY,
	"task_id" uuid NOT NULL,
	"owner" text NOT NULL,
	"actor" text NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mira_runs" ADD COLUMN "reviewed_run_id" uuid;--> statement-breakpoint
CREATE INDEX "mira_runs_conversation_history" ON "mira_runs" ("conversation_id","id");--> statement-breakpoint
CREATE INDEX "mira_runs_conversation_task" ON "mira_runs" ("owner","conversation_id","task_id") WHERE "task_id" is not null;--> statement-breakpoint
CREATE INDEX "mira_runs_task" ON "mira_runs" ("owner","task_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "mira_runs_one_active_task" ON "mira_runs" ("task_id") WHERE "task_id" is not null and "state" in ('queued','running');--> statement-breakpoint
CREATE INDEX "mira_runs_reviewed_run" ON "mira_runs" ("reviewed_run_id");--> statement-breakpoint
CREATE INDEX "mira_tasks_conversation" ON "mira_tasks" ("owner","conversation_id","id") WHERE "deleted_at" is null;--> statement-breakpoint
ALTER TABLE "mira_runs" ADD CONSTRAINT "mira_runs_reviewed_run_id_mira_runs_id_fkey" FOREIGN KEY ("reviewed_run_id") REFERENCES "mira_runs"("id");--> statement-breakpoint
ALTER TABLE "mira_task_run_reviews" ADD CONSTRAINT "mira_task_run_reviews_run_id_mira_runs_id_fkey" FOREIGN KEY ("run_id") REFERENCES "mira_runs"("id");--> statement-breakpoint
ALTER TABLE "mira_task_run_reviews" ADD CONSTRAINT "mira_task_run_reviews_task_id_mira_tasks_id_fkey" FOREIGN KEY ("task_id") REFERENCES "mira_tasks"("id");
--> statement-breakpoint
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM mira_tasks t WHERE t.conversation_id IS NOT NULL
        AND (EXISTS (SELECT 1 FROM mira_tasks other WHERE other.owner=t.owner AND other.id<>t.id AND other.conversation_id=t.conversation_id)
        OR EXISTS (SELECT 1 FROM mira_runs r WHERE r.owner=t.owner AND r.conversation_id=t.conversation_id AND r.task_id IS NOT NULL AND r.task_id<>t.id))
    ) THEN
        RAISE EXCEPTION 'Conflicting task conversation links must be separated before enabling task execution.';
    END IF;
    IF EXISTS (
        SELECT t.id FROM mira_tasks t JOIN mira_runs r ON r.owner=t.owner
            AND (r.task_id=t.id OR (r.task_id IS NULL AND r.conversation_id=t.conversation_id))
        WHERE r.state IN ('queued','running')
        GROUP BY t.id HAVING count(*)>1
    ) THEN
        RAISE EXCEPTION 'Active task run collisions must be stopped before enabling task execution.';
    END IF;
END $$;
--> statement-breakpoint
UPDATE mira_runs r SET task_id=t.id FROM mira_tasks t WHERE t.owner=r.owner AND t.conversation_id=r.conversation_id AND r.task_id IS NULL;
