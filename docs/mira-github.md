# Mira reviewed GitHub publication

Mira can prepare a local code proposal from one successful fixed structured-edit Daytona check. Chat and Jobs expose Code changes, where the signed-in operator reviews the complete selected file replacements/deletions and PR text before creating a draft PR. The runtime dispatches that exact approved snapshot through a durable queue. This change does not provision a live credential or enable production publication.

## Fixed identity and destination

The only destination is the public `rajohan/homelab` repository (numeric ID `1370070466`), based on `main`. Every mutation rechecks that the explicit credential belongs to `mira-2026` (account ID `264348558`) and has push access to that repository. Both Git author and committer are separately fixed and verified as `Mira <mira-2026@agentmail.to>`.

Runtime configuration accepts only a dedicated `HOMELAB_MIRA_GITHUB_TOKEN` and explicit `HOMELAB_MIRA_GITHUB_OWNER` through a supplied settings object. It does not discover CLI sessions, `GH_TOKEN`, `GITHUB_TOKEN`, a host checkout or credentials in a model/sandbox. The binding fingerprint excludes the token so rotation does not silently change the account, repository or operator mapping. A future deployment must provision repository-scoped Contents and Pull requests write permissions for Mira; workflow changes may require separate provider permissions. The adapter never grants permissions or falls back to another account.

## Exact selected changes

Publication takes a service-owned UUID, exact base commit, SHA-256 of the selected edit document, approved title/body and fixed commit time. It shares the strict edit-plan parser with the Daytona harness: at most 20 non-overlapping relative paths, one MiB of JSON, and passive UTF-8 replacements/originals up to 256 KiB each. Existing files must be regular Git blobs with matching Git object identity and original SHA-256. New files must be absent. Executable bits, BOMs and line endings are preserved; symlinks, submodules, traversal and binary edits are refused for selected paths.

The adapter checks current main, reads the complete bounded base tree, then creates a tree using `base_tree` so unchanged files remain present. A readback compares every resulting leaf entry, including untouched files, against the expected tree. It creates and verifies a single-parent commit, a new `mira/publication/<UUID>` branch and a draft pull request. It never updates or deletes an existing ref, merges, deploys or claims that checks passed. Main advancing or a conflicting destination requires inspection and a fresh proposal.

## Approval, pause and recovery

The proposal captures an owned, completed check with exit code zero and confirmed sandbox cleanup, the exact fixed check command/base commit, and the immutable selected edit-file ID and SHA-256. Source bytes and provenance are verified for review, approval and before each external write. A check can have only one queued or attempted publication. Sandbox output remains untrusted: its successful exit is evidence for this selected check, not a substitute for GitHub CI, code/security review or CODEOWNER approval.

The operator approves the full versioned content hash and snapshot. Approval lasts 15 minutes and is bound to the current GitHub control version, runtime binding and dashboard receiver heartbeat. `integration:github` has its own pause control. Expiry, pause or removed configuration returns unstarted work to review. Draft edits invalidate approval. Models can list status and prepare local drafts in their own conversation; they cannot approve, publish, merge or deploy. Automatic runs do not receive the draft tool; improvement-scheduler authorization remains separate future work.

Only one publication can be in progress at a time. Each attempt records its token, authored time, sending/confirmed phase and known tree/commit/branch/PR references durably. A preflight failure before any write returns the proposal to review. An interrupted or uncertain attempt becomes Needs attention and is never automatically replayed. Inspect GitHub requests only read operations; it records any recovered branch or PR without changing publication authority or retrying writes. Conversation deletion and edit-file deletion are blocked while publication is queued or running. After cancellation/completion, deleting a conversation scrubs local proposal text while retaining external references needed for recovery.

Each invocation has a two-minute ceiling, each HTTP request a 15-second limit and each response a four-MiB bound. Requests use only the fixed GitHub API origin with redirects refused. External writes have no automatic retry. A lost response, failed verification or failed confirmation receipt after a POST is reported as uncertain. Read-only reconciliation can independently observe the attempt branch and any matching PR, including closed PRs; absence is never authority to replay an uncertain request. Objects created before an interruption may remain unreferenced. The adapter does not delete them or alter an existing branch.

Before activation, delivery still needs provider qualification, scoped credential provisioning and production acceptance. Automatic improvement publication also needs a separately configured authorization policy. Existing GitHub development operations continue to use the managed `gh` wrapper on main with Mira identity verification.

## Validation and API references

Tests use a synthetic GitHub transport, with no live API writes. They cover source-byte verification, preserved files/modes, wrong identity and authorship, changed main/branches, malformed and oversized responses, revocation/cancellation, uncertain responses at every mutation, durable-receipt failure and read-only reconciliation. Existing sandbox patch roundtrips exercise the extracted shared parser.

The adapter uses the documented REST Git data and pull-request APIs with an explicit API version (`2026-03-10`): [trees](https://docs.github.com/en/rest/git/trees), [commits](https://docs.github.com/en/rest/git/commits), [references](https://docs.github.com/en/rest/git/refs) and [pull requests](https://docs.github.com/en/rest/pulls/pulls).
