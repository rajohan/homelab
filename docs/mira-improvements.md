# Automatic frontend improvements

An improvement automation can submit one small frontend change through an explicit, per-automation coding permission. The durable server workflow verifies the current source and competing PRs, queues the fixed Daytona check, waits for successful results and confirmed sandbox deletion, then queues one draft PR with Mira. The model turn can finish while these steps continue. Outcome reports link back to the originating run and the recorded jobs.

This implements the workflow, not production activation. Live Daytona account/snapshot qualification and dedicated Mira GitHub credentials remain deployment prerequisites. Existing automations receive no coding permission automatically.

## Operator workflow

In **Automations**, open the improvement automation's actions and choose **Code permissions**. Review the scope and resource use before allowing it. Both qualified integrations must be enabled and current. The schedule and **Automatic work** control remain independent; allowing code changes does not enable either or start a run. Permission applies only to runs created after the grant.

The fixed policy allows at most ten `.ts`, `.tsx` or `.css` files beneath `apps/dashboard/src/browser/` and `packages/ui/src/components/`. Each original and replacement is limited to 64 KiB, with a 256 KiB complete edit-plan limit. Existing files require exact original SHA-256 fingerprints; the plan is bound to current main. There is one fixed ten-minute check per submitted run, at most two accepted attempts per rolling 24 hours, and one globally active or unresolved automatic workflow. Failed preflight attempts count. The underlying Daytona dispatcher also retains its separate admission limits. These limits bound work; they are **not a currency cap**. The dialog explicitly identifies Daytona credits/billing before permission is granted.

The automation inspects tasks, current source, applicable repository instructions and open PRs using passive tools, then calls `mira_improvement_submit`. Submission only means queued. A changed main, incomplete inventory, existing open Mira PR, invalid source, failed check or unconfirmed cleanup prevents publication. PR listings are observations and cannot atomically exclude a competing PR opened after the final check. GitHub publication uses the existing exact-content outbox, fixed repository/account, verified author and committer, and uncertain-write protections. The workflow never merges or deploys.

Improvement runs have a restricted tool surface for repository, task and operational context. Private memory, inbox and unrelated integration tools are denied. No GitHub or Daytona credential is passed to the model or sandbox. Repository content cannot grant new authority or change the fixed command. Other automation kinds and ordinary Chat cannot submit an automatic improvement.

## Pause, changes and recovery

Pause the individual automation, Automatic work, Daytona or GitHub to revoke the workflow's captured control versions. Re-enabling does not revive old work. Revoking the coding permission, editing the automation, changing its mapped account/snapshot, cancellation, deleted conversation or a one-hour workflow lifetime also stop further steps. Definition/provider changes need a fresh coding grant. Whole-sandbox cleanup continues independently of permission, and an already-issued external request may still finish.

The coordinator and outboxes hold separate durable leases. Restarting the executor resumes recorded local phases without starting a second provider mutation. A failed check is not automatically retried. An uncertain publication remains blocked and is never resent. Review **Cloud jobs** and **Code changes** on Jobs. Confirm or resolve sandbox cleanup first; an uncertain GitHub result needs a successful **Inspect GitHub** observation within fifteen minutes. Then the automation's Code permissions dialog accepts a review note and **Close reviewed attempt**. This records the operator decision and releases the automatic-work block; it does not change the external outcome, erase the proposal or retry a write. Existing open Mira PRs still block the next attempt.

Queued and active attempts protect their conversations and input files from deletion. After completion, conversation deletion scrubs the retained edit payload and message while preserving bounded operational identifiers. The migration adds grants and attempts without granting or enabling any existing automation.

## Validation

Synthetic provider integration tests exercise grant ownership/versioning, old-run rejection, concurrency and daily admission, private-tool denial, source preflight, pause during reads, check/cleanup failures, modified artifacts, downstream revocation, publication and report creation, deletion protection and reviewed recovery. UI tests cover exact-version consent, unavailable-provider revocation and review-note submission. No live provider writes or paid sandbox allocations are needed for these tests.
