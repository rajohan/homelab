ALTER TABLE "mira_switches" ADD COLUMN "binding_activated_at" timestamp with time zone;
--> statement-breakpoint
UPDATE "mira_switches" s SET "binding_activated_at"=COALESCE((SELECT max(w.started_at) FROM mira_control_windows w WHERE w.owner=s.owner AND w.key=s.key),s.changed_at) WHERE s.key='integration:agentmail' AND s.binding_hash IS NOT NULL;
