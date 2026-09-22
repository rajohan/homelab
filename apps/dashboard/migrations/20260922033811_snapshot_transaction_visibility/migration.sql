ALTER TABLE "operation_snapshots" ADD COLUMN "mutation_xid" text DEFAULT pg_current_xact_id() NOT NULL;
--> statement-breakpoint
-- Stamp the top-level 64-bit transaction ID, including writes in savepoints.
-- A pre-read pg_snapshot can distinguish committed-visible data from a writer
-- whose statement happened earlier but whose commit happened after discovery.
CREATE OR REPLACE FUNCTION homelab_snapshot_mutation_watermark() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    NEW.mutated_at := clock_timestamp();
    NEW.mutation_xid := pg_current_xact_id()::text;
    RETURN NEW;
END;
$$;
