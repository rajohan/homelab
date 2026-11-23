ALTER TABLE "mira_conversations" ALTER COLUMN "settings" SET DEFAULT '{"model":null,"effort":null,"serviceTier":null,"executionTarget":"main"}';--> statement-breakpoint
ALTER TABLE "mira_runs" ALTER COLUMN "settings" SET DEFAULT '{"model":null,"effort":null,"serviceTier":null,"executionTarget":"main"}';--> statement-breakpoint
ALTER TABLE "mira_automations" ALTER COLUMN "settings" SET DEFAULT '{"model":null,"effort":null,"serviceTier":null,"executionTarget":"main"}';--> statement-breakpoint
-- Refresh the old generated brief on unfinished dependency tasks. Preserve operator edits,
-- chat history and run records. Applying a release does not start or replay a task.
UPDATE mira_tasks
SET description = replace(description,
    'Verify each upstream release, follow the repository''s pin and integrity workflow, and inspect affected integrations. Wait for operator review before opening a PR, merging, publishing or deploying.',
    'Verify each upstream release and update its pins. For NuGet packages, use mira_dependency_package to read the official artifact SHA-256. Run the structured edits through mira_code_edit on the selected target. After successful checks and cleanup, use mira_github_create_pr to open one pull request for the operator. Record its URL on the task. Leave merge, release and deployment to the operator.'),
    completion_criteria = 'Record the open pull request URL, changed pins and verification results.',
    version = version + 1, updated_at = now()
WHERE deleted_at IS NULL AND status <> 'done' AND substr(id::text, 15, 1) = '8'
    AND labels @> '["dependencies"]'::jsonb
    AND completion_criteria = 'Provide the branch, changed pins and verification results for review.'
    AND description LIKE 'In an isolated checkout of %, prepare these source dependency updates together on one review branch:' || chr(10) || '- %' || chr(10) || 'Verify each upstream release, follow the repository''s pin and integrity workflow, and inspect affected integrations. Wait for operator review before opening a PR, merging, publishing or deploying.';
