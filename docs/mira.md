# Mira

Mira is being built into Homelab. The dashboard owns conversations, files, tasks,
automations, reports, permissions and memory. An isolated agent runtime provides
inference and tool orchestration. Replacing that runtime must not require replacing
the product's data model.

The core implementation includes the [runtime qualification](mira-runtime.md), a
separate `apps/mira` executor, authenticated dashboard routes, PostgreSQL state,
files, task board, automations and reports. It is qualified in disposable development
environments and has not been deployed to production. OpenClaw and the retired
dashboard remain migration sources, not permanent dependencies. No third-party
patches are part of this design.

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

| Delivery                   | Scope                                                                                                                        | Status                                                                                                                                                     |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime qualification      | Separate ChatGPT login; streaming, host tools, interruption and process replacement                                          | Implemented; isolated live qualification passed                                                                                                            |
| Chat and files             | Owned conversations, streaming, cancellation, search/archive/delete, bounded uploads and editable memory                     | Implemented; synthetic preview and live text/PDF/image qualification passed                                                                                |
| Tasks                      | Four-column drag-and-drop board, keyboard controls, search/filters, versioned edits, progress and conversation links         | Board, product tools and [explicit task execution](mira-tasks.md) implemented; resource-context actions pending                                            |
| Automations and Reports    | Durable scheduler, heartbeat, reasoned individual/global pause, run history, report snapshots and deduplicated notifications | Core implemented; migrated presets installed paused; live qualification and activation pending                                                             |
| Computer control           | Dedicated browser, required Windows pairing, scoped controls, preview, local stop and takeover                               | Windows companion, installer, updates and private receiver implemented; live Windows, browser and private-route acceptance pending                         |
| Voice                      | Shared conversation context, provider qualification and explicit billing limits                                              | Pending; no paid voice budget enabled                                                                                                                      |
| Migration and integrations | Validated legacy imports, AgentMail, Daytona, here.now and Moltbook adapters                                                 | AgentMail delivery/attachments, here.now publication, Moltbook participation and reviewed Daytona jobs implemented; live qualification and cutover pending |
| Self-update                | Exact verified releases, independent deployment runner, receipts, health checks and compatible recovery                      | Mira image/release packaging implemented; replacement runner and automatic policy pending                                                                  |

Each delivery uses Bun, Valibot, Effect boundaries, existing dashboard contracts and
shared UI. Reuse cards, headers, actions, forms, lists and viewport-bounded modals;
add generic primitives only where they are genuinely reusable. UI work gets an
isolated synthetic preview before production deployment.

## Implemented core

- The dashboard exposes private Chat, Tasks, Reports and Automations routes through
  the existing authenticated tRPC boundary. Ownership checks apply to conversations,
  files, tasks, reports and notifications. User and model edits use the same validated
  services and version checks.
- Chat preserves streamed output in PostgreSQL, uses a durable idempotency key per
  submission, and can be reopened after the browser closes. Markdown, GFM tables and
  bounded code highlighting use shared components and the Monokai Sublime theme.
  Conversations and messages have separate scroll areas; controls remain available
  at small viewport sizes. Messages include their date and time. Chat settings use
  the isolated runtime's model catalog, refreshed every 30 seconds, including
  supported thinking levels and speeds. Preferences are stored per conversation and
  frozen per queued turn; unsupported combinations are rejected without silently
  switching models. Catalog availability is not proof of inference entitlement.
  Observed thinking/reply/tool stages and durable tool receipts can be displayed;
  local display preferences do not expose private reasoning or tool arguments.
  Jobs uses the shared responsive table for named conversations and run outcomes.
- Uploads accept verified PNG/JPEG/WebP, PDF and UTF-8 text up to 25 MiB per file and
  eight files per message. Storage uses owned paths, bounded quotas, content checks
  and garbage collection. PDF extraction runs in a credential-free bounded child;
  text extraction is limited to 100 pages / 256,000 characters. Images and extracted
  document context were exercised with the real isolated runtime.
- Manual conversations can create downloadable UTF-8 artifacts using `mira_file_create`,
  including Markdown, JSON, HTML and source code, up to 1 MiB each. Generated files
  use the same private file store, attachment buttons, downloads and deletion as
  uploads. Eight files per assistant response includes both generated files and mail
  imports. Identical filename/content retries within a run reuse one immutable file;
  changed content or another run creates a separate file. Filenames never select disk
  paths, and no generated content is executed. Invalid Unicode in names or content is
  rejected rather than silently replaced; valid UTF-8 bytes are retained exactly.
  Binary generation is not implemented.
  Live ownership, lease and cancellation are rechecked at acceptance; rejected writes
  remove unexposed reservations. A lost acknowledgement after a committed file is
  treated as uncertain, retains the attachment and fences further tool actions.
  Generated file IDs can be selected by the existing email/publication draft tools;
  external delivery still requires the operator's separate review and approval.
- Two Mira execution lanes reserve foreground capacity for manual requests. They do
  not consume infrastructure workers. Leases, durable tool receipts and cancellation
  fencing prevent expired workers from recording new product effects. Uncertain
  external outcomes are not automatically replayed.
- Interval, daily/cron, once and event automations share durable state. Each has its
  own pause reason and optional resumption, with a separate global pause. Dispatch
  rechecks current settings. Resuming does not replay every missed occurrence.
  Unchanged heartbeat observations stay quiet; reports and notifications are scoped
  to the owner and deduplicated.
- The current automatic tool scope reads product/dashboard observations and creates
  reports. Manual chat can manage owned tasks, progress and explicit memory. This
  core does not execute shell commands, merge code or deploy. Mail and public-site
  delivery use the separately reviewed [AgentMail](mira-agentmail.md) and
  [here.now](mira-herenow.md) outboxes; model tools only prepare their drafts. The dashboard-improvement preset remains paused until its bounded
  execution adapter is delivered and qualified.
- An optional `deploy/compose.mira.yaml` overlay runs the separately built Mira image.
  The pinned native runtime is bundled in that image; its updates follow reviewed
  Homelab releases. Auth continues to build and run independently. Release metadata
  accepts existing two-image releases and new releases that include Mira.
  The separate `deploy/compose.computer.yaml` overlay enables the machine receiver
  behind a same-host private TLS proxy; it is not part of the public dashboard route.
  See the [deployment configuration](../deploy/README.md#optional-mira-and-private-computer-receiver).

Verification includes static checks, unit/component tests, real HTTP/database
integration tests, all three application builds, built-process smoke checks and
complete source coverage inventory. The disposable UI preview uses synthetic data
and synthetic replies, with no production or provider connection. Live product
qualification is a separate operator-invoked check using only synthetic documents
and the dedicated Mira login. CI never uses those credentials.

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
before starting. The [automatic frontend policy](mira-improvements.md) requires explicit per-automation permission for a bounded fixed cloud check and draft PR. It cannot automatically merge, deploy, restart, change secrets or send unrelated external messages. Each job can be disabled independently.

AgentMail keeps Mira's existing inbox. Replace the old custom signature transform
with raw-body Svix verification, durable event acceptance, deduplication and missed
message reconciliation. Replies require explicit authority. Mail content is untrusted.

Daytona provides durable cloud jobs with reviewed commands, selected file transfers,
bounded logs and confirmed cleanup. The coding harness and snapshot still need live
qualification, including the exact Bun pin, frozen installs and output/diff recovery.
Paid activation needs qualified runtime isolation and configured spending limits;
job admission limits alone are not a currency budget.

here.now publishes only authorized outputs; internal reports stay private by default.
Moltbook retains separate participation permissions, cadence and notification rules.
Review current upstream APIs and complete skill bundles before migration. Never run
newly downloaded instructions as an updater. Preserve local policy separately.

## Skill catalog

The [release-owned skill catalog](mira-skills.md) provides inspectable, versioned guidance
for native task and integration workflows. Each skill has an independent pause and
optional timed resume; provider permissions remain separate. The catalog is implemented
and tested in disposable development state, with production activation still pending.

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
The implemented core does not install a driver or claim those tests have passed.

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

AgentMail delivery and provisioning are documented in [Mira AgentMail](mira-agentmail.md). The signed receiver, read tools, recovery, pause controls and reviewed outgoing drafts with attachments are implemented; live qualification and activation remain pending.

### Proposed product changes

Task creation, updates, progress and persistent memory proposed by a model require explicit human approval of the exact validated fields. A manual conversation is not blanket write authorization: uploads, previous reports and mail remain untrusted inputs. The chat shows **Proposed changes**, and the review dialog offers **Approve change** or **Reject**. Applying a proposal rechecks ownership and task version, and commits the product change and approval receipt in one transaction. Identical approval retries return the previous decision. Models and automation principals cannot approve proposals.

Proposals expire after 24 hours; cleanup removes their argument contents, and deleting the conversation removes pending proposal contents immediately. Each run can propose at most twenty changes. Factual report snapshots remain explicitly attributed model output; automatic runs still cannot modify tasks or memory.

## Daytona delivery

The control-plane adapter, bounded command/file toolbox, durable queue and dashboard are implemented but not activated. See [Daytona adapter qualification](mira-daytona.md) for the pinned official clients, isolation limits, recovery contract and remaining harness and live qualification work.

### Reviewed Daytona cloud jobs

Cloud jobs are available from Chat and Jobs with local drafts, exact operator review, durable execution phases, bounded logs, selected file transfers and independently confirmed cleanup. The model can propose a command and read recorded results, but cannot approve cloud spending. Daytona has its own pause control; cleanup remains active while paused. See [Daytona qualification](mira-daytona.md) for admission limits, explicit environment settings and the required live qualification before activation.
