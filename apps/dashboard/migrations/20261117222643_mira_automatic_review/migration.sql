-- One fixed manual-work policy replaces selectable permission modes.
UPDATE "mira_conversations" SET "settings"="settings"-'permissionMode', "version"="version"+1
WHERE "settings" ? 'permissionMode';
--> statement-breakpoint
UPDATE "mira_automations" SET "settings"="settings"-'permissionMode'
WHERE "settings" ? 'permissionMode';
--> statement-breakpoint
UPDATE "mira_runs" SET "settings"="settings"-'permissionMode', "approval_revoked_at"=clock_timestamp();
--> statement-breakpoint
-- A retired mode cannot leave a broader browser grant active after the transition.
UPDATE "mira_browser_access" SET "state"='stopped', "policy"="policy"-'delegatedMode'
WHERE "policy" ? 'delegatedMode';
--> statement-breakpoint
UPDATE "mira_mail_drafts" SET "message"='Review required: This pending action predates automatic review. Review or cancel it.', "updated_at"=clock_timestamp()
WHERE "state"='draft';
--> statement-breakpoint
UPDATE "mira_publications" SET "message"='Review required: This pending action predates automatic review. Review or cancel it.', "updated_at"=clock_timestamp()
WHERE "state"='draft';
--> statement-breakpoint
UPDATE "mira_social_drafts" SET "message"='Review required: This pending action predates automatic review. Review or cancel it.', "updated_at"=clock_timestamp()
WHERE "state"='draft';
--> statement-breakpoint
UPDATE "mira_code_publications" SET "message"='Review required: This pending action predates automatic review. Review or cancel it.', "updated_at"=clock_timestamp()
WHERE "state"='draft';
--> statement-breakpoint
UPDATE "mira_daytona_jobs" SET "message"='Review required: This pending action predates automatic review. Review or cancel it.', "updated_at"=clock_timestamp()
WHERE "state"='draft';
