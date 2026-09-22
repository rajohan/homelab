ALTER TABLE "operation_snapshots" ADD COLUMN "mutated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL;
--> statement-breakpoint
-- Source captured_at remains the observation/freshness clock. Every insert and
-- mutation has a separate DB-owned clock, including resolver and receipt writes.
CREATE FUNCTION homelab_snapshot_mutation_watermark() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.mutated_at := clock_timestamp();
    RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER operation_snapshots_mutation_watermark
BEFORE INSERT OR UPDATE ON operation_snapshots
FOR EACH ROW EXECUTE FUNCTION homelab_snapshot_mutation_watermark();
