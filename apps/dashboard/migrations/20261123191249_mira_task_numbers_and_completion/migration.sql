ALTER TABLE "mira_tasks" ADD COLUMN "task_number" integer;--> statement-breakpoint
ALTER TABLE "mira_tasks" ADD COLUMN "completed_at" timestamp with time zone;--> statement-breakpoint
-- Older tasks did not record completion separately. Freeze the best available
-- timestamp once, so future edits cannot change their place in Done.
WITH numbered AS (
    SELECT id, row_number() OVER (PARTITION BY owner ORDER BY created_at, id) AS number
    FROM mira_tasks
)
UPDATE mira_tasks t SET task_number = numbered.number,
    completed_at = CASE WHEN t.status = 'done' THEN t.updated_at END
FROM numbered WHERE numbered.id = t.id;--> statement-breakpoint
ALTER TABLE "mira_tasks" ALTER COLUMN "task_number" SET NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "mira_tasks_owner_number" ON "mira_tasks" ("owner","task_number");--> statement-breakpoint
CREATE FUNCTION mira_task_board_fields() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- Deleted tasks retain their row and keep their number reserved.
        PERFORM pg_advisory_xact_lock(hashtextextended('mira:task-number:' || NEW.owner, 0));
        SELECT coalesce(max(task_number), 0) + 1 INTO NEW.task_number
            FROM mira_tasks WHERE owner = NEW.owner;
        IF NEW.status = 'done' THEN NEW.completed_at := clock_timestamp(); END IF;
    ELSIF NEW.status IS DISTINCT FROM OLD.status THEN
        NEW.completed_at := CASE WHEN NEW.status = 'done' THEN clock_timestamp() END;
    END IF;
    RETURN NEW;
END;
$$;--> statement-breakpoint
CREATE TRIGGER mira_task_board_fields BEFORE INSERT OR UPDATE OF status ON mira_tasks
    FOR EACH ROW EXECUTE FUNCTION mira_task_board_fields();
