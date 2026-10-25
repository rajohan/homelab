# Mira GitHub publication foundation

This adapter is the first part of reviewed code publication. It is not connected to the runtime configuration, a dispatcher, dashboard actions, model tools or the improvement scheduler yet. No live credential is provisioned and no production publication is enabled by this change.

## Fixed identity and destination

The only destination is the public `rajohan/homelab` repository (numeric ID `1370070466`), based on `main`. Every mutation rechecks that the explicit credential belongs to `mira-2026` (account ID `264348558`) and has push access to that repository. Both Git author and committer are separately fixed and verified as `Mira <mira-2026@agentmail.to>`.

Configuration accepts only a dedicated `HOMELAB_MIRA_GITHUB_TOKEN` and explicit `HOMELAB_MIRA_GITHUB_OWNER` through a supplied settings object. It does not discover CLI sessions, `GH_TOKEN`, `GITHUB_TOKEN`, a host checkout or credentials in a model/sandbox. The binding fingerprint excludes the token so rotation does not silently change the account, repository or operator mapping. A future deployment must provision repository-scoped Contents and Pull requests write permissions for Mira; workflow changes may require separate provider permissions. The adapter never grants permissions or falls back to another account.

## Exact selected changes

Publication takes a service-owned UUID, exact base commit, SHA-256 of the selected edit document, approved title/body and fixed commit time. It shares the strict edit-plan parser with the Daytona harness: at most 20 non-overlapping relative paths, one MiB of JSON, and passive UTF-8 replacements/originals up to 256 KiB each. Existing files must be regular Git blobs with matching Git object identity and original SHA-256. New files must be absent. Executable bits, BOMs and line endings are preserved; symlinks, submodules, traversal and binary edits are refused for selected paths.

The adapter checks current main, reads the complete bounded base tree, then creates a tree using `base_tree` so unchanged files remain present. A readback compares every resulting leaf entry, including untouched files, against the expected tree. It creates and verifies a single-parent commit, a new `mira/publication/<UUID>` branch and a draft pull request. It never updates or deletes an existing ref, merges, deploys or claims that checks passed. Main advancing or a conflicting destination requires inspection and a fresh proposal.

## Durable caller obligations

The future dispatcher must provide durable admission, exact human approval or an explicitly configured automation policy, ownership, pause checks, attempt fencing and selected-file provenance. Its guard is called before every write and again after the durable `sending` receipt. The progress callback must durably record `sending` and `confirmed` phases plus known tree/commit/branch/PR references. A failed receipt prevents further writes. These callbacks are required parameters, not a substitute for the durable workflow still to be implemented.

Each invocation has a two-minute ceiling, each HTTP request a 15-second limit and each response a four-MiB bound. Requests use only the fixed GitHub API origin with redirects refused. External writes have no automatic retry. A lost response, failed verification or failed confirmation receipt after a POST is reported as uncertain. Read-only reconciliation can independently observe the attempt branch and any matching PR, including closed PRs; absence is never authority to replay an uncertain request. Objects created before an interruption may remain unreferenced. The adapter does not delete them or alter an existing branch.

Before activation, delivery still needs a durable queue and reconciliation UI, exact source/test-result binding, operator controls and automation policy, provider qualification, scoped credential provisioning and production acceptance. Existing GitHub development operations continue to use the managed `gh` wrapper on main with Mira identity verification.

## Validation and API references

Tests use a synthetic GitHub transport, with no live API writes. They cover source-byte verification, preserved files/modes, wrong identity and authorship, changed main/branches, malformed and oversized responses, revocation/cancellation, uncertain responses at every mutation, durable-receipt failure and read-only reconciliation. Existing sandbox patch roundtrips exercise the extracted shared parser.

The adapter uses the documented REST Git data and pull-request APIs with an explicit API version (`2026-03-10`): [trees](https://docs.github.com/en/rest/git/trees), [commits](https://docs.github.com/en/rest/git/commits), [references](https://docs.github.com/en/rest/git/refs) and [pull requests](https://docs.github.com/en/rest/pulls/pulls).
