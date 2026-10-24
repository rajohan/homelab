# Mira

Mira is being built into Homelab. The dashboard owns conversations, files, tasks,
automations, reports, permissions and memory. An isolated agent runtime provides
inference and tool orchestration. Replacing that runtime must not require replacing
the product's data model.

The first implementation is the [runtime qualification](mira-runtime.md) in
`apps/mira`. It is an operator-invoked pilot, with no production listener, scheduled
work or dashboard route yet. OpenClaw and the retired dashboard remain migration
sources, not permanent dependencies of the new product. No third-party patches are
part of this design.

## Deployment boundaries

The dashboard, Mira executor, durable state, scheduler, integrations and files run
on the server. A browser closing or a personal computer going offline must not stop
server-side work. OpenAI inference remains provider-hosted.

Windows computer control needs a separately paired companion in the user's desktop
session. That companion runs locally; it does not host the assistant's scheduler or
database. Sleep, lock, disconnect and revocation make that target unavailable.
Server-side work that does not need the PC continues.

All custom code, migrations, adapters, bundled skills, helper sources, deployment
definitions and tests belong in this repository. Credentials, runtime homes,
conversations and uploaded files remain outside Git. Authentication stays independent
of both the dashboard and Mira. Long agent turns use separate execution capacity,
not the reserved light infrastructure worker.

## Delivery sequence

| Delivery                            | Scope                                                                                                                        | Status                                                                           |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| Runtime and migration qualification | Separate ChatGPT login; streaming, host tools, interruption, process replacement; source inventory; Windows driver selection | Runtime pilot implemented; desktop acceptance and data migration mapping pending |
| Chat, files and Tasks               | Durable conversations; bounded uploads; task board; linked progress and outputs; stop/resume; responsive preview             | Planned                                                                          |
| Computer control                    | Dedicated browser and isolated desktop; required Windows pairing, scoped tools, preview, local stop and takeover             | Driver candidate identified; companion and acceptance pending                    |
| Automations and Reports             | Durable scheduler, heartbeat, recovered jobs, reasoned disable, global pause, reports and event delivery                     | Planned                                                                          |
| Voice                               | Same conversation and task context; qualified provider; explicit billing and session limits                                  | Planned; no paid voice budget enabled                                            |
| Migration and memory                | Editable memory, validated imports, integrations and cutover without duplicate schedulers                                    | Planned                                                                          |
| Self-update                         | Verified releases, independent deployment runner, persisted receipts, health verification and compatible recovery            | Planned                                                                          |

Each delivery uses Bun, Valibot, Effect boundaries, existing dashboard contracts and
shared UI. Reuse cards, headers, actions, forms, lists and viewport-bounded modals;
add generic primitives only where they are genuinely reusable. UI work gets an
isolated synthetic preview before production deployment.

## Product data and behavior

- Conversations retain streaming messages, attachments, search, archive/delete and
  links to tasks. Text and voice share context. Memory is separately inspectable,
  editable and removable. Resource pages can pass explicit context to Mira.
- Tasks restore todo, in-progress, blocked and done; Mira/Raymond assignment;
  priorities, labels, descriptions, search, filters and attributed progress. Add
  due dates, completion criteria and links to conversations, files, runs and reports.
  Assignment alone does not authorize privileged execution. Task state is separate
  from queued/running/awaiting-input/failed execution state.
- Automations support one-time, interval, daily, cron and events using the existing
  durable scheduling foundation. Recurrence survives completion of one invocation.
  Heartbeat is editable and quiet when nothing actionable changes. Runs have bounded
  budgets, concurrency, retries and durable outcomes.
- Every automation, skill, integration and computer target supports independent
  disable with a reason and optional resumption. Global automatic-work pause is
  separate from stopping a running task. Recheck current state before dispatching
  queued work or alerts; intentional disable suppresses its own stale/missing-run
  warnings, not unrelated incidents. Resume without replaying every missed run.
- Reports include brief, summary, heartbeat findings and improvement outcomes.
  Preserve immutable Markdown snapshots, pagination, search, type/source/status/date
  filters and stable links. Archive/deletion preserves execution/audit history.
  A quiet check need not create a report; scheduled brief/summary do.
- Tools use typed dashboard operations and preserve host locks, human approvals and
  recent-MFA requirements. Mail, documents, websites and skill content cannot grant
  authority. Retries must not duplicate external effects or replies.

## Recovered jobs and integrations

The old automation definitions were inspected read-only. These are migration defaults,
not active replacement schedules. All times are Europe/Oslo:

| Job                   | Schedule        | Result                                                                                          |
| --------------------- | --------------- | ----------------------------------------------------------------------------------------------- |
| Daily brief           | 07:30           | Useful weather, quotas, tasks, blockers and material operational findings in a dashboard report |
| Daily summary         | 22:00           | Accomplishments, remaining work and material observations in a dashboard report                 |
| Dashboard improvement | 09:30 and 18:30 | At most one bounded improvement PR per pass, or an explained skip/blocker                       |

Dashboard improvement uses an isolated worktree, Mira's verified GitHub identity,
current Bun pin, shared components and required checks. It checks existing tasks/PRs
before starting. It cannot automatically merge, deploy, restart, change secrets,
spend money or send external messages. Each job can be disabled independently.

AgentMail keeps Mira's existing inbox. Replace the old custom signature transform
with raw-body Svix verification, durable event acceptance, deduplication and missed
message reconciliation. Replies require explicit authority. Mail content is untrusted.

Daytona/Crabbox provides bounded disposable verification environments after its CLI,
SDK, snapshots and runner are qualified together. Preserve the exact Bun pin,
frozen installs, output/diff recovery, timeouts and cleanup on every exit path.
Paid activation needs configured resource and spending limits.

here.now publishes only authorized outputs; internal reports stay private by default.
Moltbook retains separate participation permissions, cadence and notification rules.
Review current upstream APIs and complete skill bundles before migration. Never run
newly downloaded instructions as an updater. Preserve local policy separately.

## Computer control acceptance

The current candidate is the maintained [Cua Driver](https://cua.ai/docs/cua-driver),
using its documented MCP/SDK surface rather than private desktop-app credentials.
The runtime remains on the server; the Windows companion owns the local driver.
Driver discovery is not proof of usable desktop access.

Use bounded manifests. Browser and native-app work need separate scopes: generic
desktop input can bypass an origin-only browser restriction. Grant exact apps/sites,
restrict full-desktop capture, and retain the driver's own enforcement. See the
[upstream permission contract](https://cua.ai/docs/cua-driver/guides/permissions).

Pairing must be authenticated, revocable and preferably initiated from the PC.
Require one controller, current observations, action expiry, local stop and visible
takeover/pause. Never replay stale clicks after reconnecting. Preserve reasoned
disable across updates, and replace the companion/driver only between sessions.

Acceptance requires actual permitted browser and native Windows-app tasks, denied
targets, cancellation/takeover, lock/sleep/disconnect recovery and verified updates.
The first runtime PR does not install a driver or claim those tests have passed.

## Updates and cutover

| Component                                              | Owner                                                                                |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Mira application, companion, hooks and bundled helpers | Homelab PR, checks, release and deployment                                           |
| Bun application SDKs and CI dependencies               | Existing Dependabot groups and release policy                                        |
| Separately installed Codex                             | Existing native Codex update target; no competing installer                          |
| Selected desktop driver / sandbox tools                | Explicit qualified update target, or pinned image dependency before activation       |
| Third-party skills                                     | Source/version/hash manifest and reviewed update PR; preserve policy overrides       |
| Hosted provider services                               | Provider-managed; show adapter compatibility rather than inventing an install action |

Self-update must use exact verified release artifacts and a finite host runner that
survives replacement of its own dashboard/worker. Persist intent and receipts,
drain/reconcile work, verify the running revision and health, and qualify recovery
against actual schema compatibility. Image rollback is not database rollback.
Automatic deployment is a separate opt-in policy and cannot bypass PR approval.

Before cutover, dry-run task/progress/report/attachment mappings, preserve original
records, check ownership and links, and prevent duplicate old/new scheduled execution.
Test DST, missed schedules, concurrent edits, notification races and process crashes.
The feature is not complete until Windows acceptance, external adapters, updates,
disable preservation and server-side independent execution pass their checks.
