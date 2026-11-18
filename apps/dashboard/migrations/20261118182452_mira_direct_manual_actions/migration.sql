-- Remove the retired duration selector without changing grants or starting work.
UPDATE mira_conversations SET settings=settings-'liveAssistanceMinutes' WHERE settings ? 'liveAssistanceMinutes';
--> statement-breakpoint
UPDATE mira_automations SET settings=settings-'liveAssistanceMinutes' WHERE settings ? 'liveAssistanceMinutes';
--> statement-breakpoint
UPDATE mira_runs SET settings=settings-'liveAssistanceMinutes',effective_settings=effective_settings-'liveAssistanceMinutes'
WHERE settings ? 'liveAssistanceMinutes' OR effective_settings ? 'liveAssistanceMinutes';
