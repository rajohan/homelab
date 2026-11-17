-- Retire removed provider preferences without changing unrelated controls or past outcomes.
UPDATE "mira_conversations"
SET "settings" = "settings" || '{"model":null,"effort":null,"serviceTier":null}'::jsonb,
    "version" = "version" + 1
WHERE "settings"->>'model' LIKE 'syn:%';
--> statement-breakpoint
UPDATE "mira_conversations" SET "model" = NULL, "provider_context_ready" = false
WHERE "model" LIKE 'syn:%';
--> statement-breakpoint
UPDATE "mira_automations"
SET "settings" = "settings" || '{"model":null,"effort":null,"serviceTier":null}'::jsonb,
    "version" = "version" + 1
WHERE "settings"->>'model' LIKE 'syn:%';
--> statement-breakpoint
UPDATE "mira_runs"
SET "settings" = "settings" || '{"model":null,"effort":null,"serviceTier":null}'::jsonb
WHERE "state" = 'queued' AND "settings"->>'model' LIKE 'syn:%';
--> statement-breakpoint
UPDATE "mira_runtime_status" SET "models" = '[]'::jsonb, "quotas" = '[]'::jsonb,
    "model" = NULL, "ready" = false;
--> statement-breakpoint
ALTER TABLE "mira_runtime_status" DROP COLUMN "synthetic_owner";
