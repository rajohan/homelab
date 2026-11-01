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

## Chat permissions

Chat settings offers Ask for approval, Approve for me and Full access. The selected mode is stored with the conversation and enforced by the same server for web and Windows. See [Chat permissions](mira-permissions.md) for exact action scopes, revocation and deployment requirements.

## Deployment boundaries

All product functionality must remain available in the website, including Chat,
Tasks, Automations, files, model selection and the browser workspace. The planned
full Windows client uses the same server APIs, permissions and persisted state;
features must not become Windows-only. Local PC control, pairing and the system
tray are companion capabilities. Closing either client does not stop server work.

On iPhone, open the dashboard in Safari, use **Share → Add to Home Screen**, keep
**Open as Web App** enabled if shown, and tap **Add**. The installed Homelab icon
opens the same website in a standalone window. Sign in inside that window if
requested: iOS can keep its session separate from Safari. The manifest starts at
the dashboard root, so installing from a conversation does not pin a private chat
URL. The browser keeps its default safe-area insets around system controls.

The home-screen app needs access to the server through the home network or
Meshnet, just like the website. Installation does not add offline execution, push
notifications or local PC control to iOS. No service worker stores private API
responses or an outdated application shell; reopening loads the deployed UI while
server-side jobs continue independently.

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

| Delivery                 | Scope                                                                                                                        | Status                                                                                                                                                     |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime qualification    | Separate ChatGPT login; streaming, host tools, interruption and process replacement                                          | Implemented; isolated live qualification passed                                                                                                            |
| Chat and files           | Owned conversations, streaming, cancellation, search/archive/delete, bounded uploads and editable memory                     | Implemented; synthetic preview and live text/PDF/image qualification passed                                                                                |
| Tasks                    | Four-column drag-and-drop board, keyboard controls, search/filters, versioned edits, progress and conversation links         | Board, product tools and [explicit task execution](mira-tasks.md) implemented; resource-context actions pending                                            |
| Automations and Reports  | Durable scheduler, heartbeat, reasoned individual/global pause, run history, report snapshots and deduplicated notifications | Core implemented; new presets installed paused; live qualification and activation pending                                                                  |
| Computer control         | Dedicated browser, required Windows pairing, scoped controls, preview, local stop and takeover                               | Windows companion, browser host/Chat queue and isolated egress implemented; actual Windows PC and private-route acceptance pending                         |
| Voice                    | Shared conversation context, provider qualification and explicit billing limits                                              | Pending; no paid voice budget enabled                                                                                                                      |
| Integrations and cutover | Fresh Mira state, AgentMail, Daytona, here.now and Moltbook adapters                                                         | AgentMail delivery/attachments, here.now publication, Moltbook participation and reviewed Daytona jobs implemented; live qualification and cutover pending |
| Self-update              | Exact verified releases, independent deployment runner, receipts, health checks and compatible recovery                      | Verified release runner, backup/recovery and optional automatic policy implemented; host recipe and activation pending                                     |

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
- **Context** in Chat settings and each automation controls saved memory and
  cross-conversation history. Both default to enabled for existing and new settings;
  changes apply to future runs. Model changes preserve these choices. Chat context
  settings remain editable when the model catalog is offline.
  Mira receives bounded excerpts from the owner's latest saved memories and can
  search completed messages in their other included conversations, with source
  links and dates. History uses PostgreSQL word/phrase search, not semantic search
  or unlimited recall. Read tools recheck ownership, deletion, archival and source
  opt-outs. The current conversation is excluded from this search.
  Same-conversation retrieval is separate: Mira can browse or search eight earlier
  message excerpts at a time with `mira_conversation_history`, then read 6000-character
  chunks with `mira_history_read`. This remains available when cross-conversation
  history is off, but not in restricted improvement or assessment runs. Retrieval
  stops before the current turn's user message and rechecks the owned live lease.
  Provider recovery supplies at most 32 recent messages and 48,000 characters, with
  message IDs, dates and explicit omissions. Older text stays in the database and
  can be retrieved on demand; it is not all sent on every turn. Failed/interrupted
  messages retain their state and are not proof that an action succeeded. Switching
  back from Synthetic restores intervening product messages. Provider-private
  reasoning is not transferred, and older images may need to be attached again.
  Relevant context goes to the provider selected for the run (ChatGPT or Synthetic);
  no separate embedding service or duplicate history store is added. Dashboard
  improvement and task-change assessments cannot retrieve private memory/history.
  Disabling history also excludes that conversation from future searches. It does
  not remove facts already included in previous replies. Changing effective recall
  permissions rebuilds native provider context from the current conversation's
  messages, without retaining the previous provider thread's hidden tool results.
  Mira proactively saves useful preferences, confirmed decisions and ongoing-work
  context without a separate save request or approval. It can update an existing
  version when facts change. Both actions retain ownership, lease, version and audit
  checks; disabling memory blocks reading and writing it. Memories remain visible,
  editable and deletable in Memory. Untrusted source instructions and secrets must
  not become memories. This is distinct from searching existing conversation history,
  which does not create memory records.
  Memory upkeep also runs as an individually pausable daily automation (03:30,
  Europe/Oslo). It checks newer evidence, merges duplicate notes and removes
  demonstrably obsolete records; old but valid preferences are retained. Its model
  and context choices use the same automation controls. New installations include
  the preset paused for review. Existing installations add and enable this definition
  during rollout without reinstalling or altering their existing automations.
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
before starting. The [automatic repository policy](mira-improvements.md) requires explicit per-automation permission for a bounded fixed Main or Daytona check and draft PR. It cannot automatically merge, deploy, restart, change secrets or send unrelated external messages. Each job can be disabled independently.

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

The operator declined legacy data migration on 2026-10-31. Start new Mira tasks,
reports, progress and conversation history without importing the old dashboard.
This does not authorize deleting the old database. Preserve the requested brief,
summary and improvement behavior using the new paused presets. During cutover,
stop the old execution owners before enabling their replacements so jobs cannot
run twice. The current Homelab database and its existing infrastructure history
remain part of the ordinary backed-up schema upgrade.
Test DST, missed schedules, concurrent edits, notification races and process crashes.
The feature is not complete until Windows acceptance, external adapters, updates,
disable preservation and server-side independent execution pass their checks.

AgentMail delivery and provisioning are documented in [Mira AgentMail](mira-agentmail.md). The signed receiver, read tools, recovery, pause controls and reviewed outgoing drafts with attachments are implemented; live qualification and activation remain pending.

### Proposed product changes

Task creation, updates and progress proposed by a model require explicit human approval of the exact validated fields. A manual conversation is not blanket write authorization: uploads, previous reports and mail remain untrusted inputs. The chat shows **Proposed changes**, and the review dialog offers **Approve change** or **Reject**. Applying a proposal rechecks ownership and task version, and commits the product change and approval receipt in one transaction. Identical approval retries return the previous decision. Models and automation principals cannot approve proposals. Memory is separately authorized by the Context setting and can be maintained automatically, with the same ownership, version and audit protections. Pending memory proposals from older releases remain reviewable.

Proposals expire after 24 hours; cleanup removes their argument contents, and deleting the conversation removes pending proposal contents immediately. Each run can propose at most twenty changes. Factual report snapshots remain explicitly attributed model output; automatic runs still cannot modify tasks.

## Daytona delivery

The control-plane adapter, bounded command/file toolbox, durable queue and dashboard are implemented but not activated. See [Daytona adapter qualification](mira-daytona.md) for the pinned official clients, isolation limits, recovery contract and remaining harness and live qualification work.

### Reviewed Daytona cloud jobs

Cloud jobs are available from Chat and Jobs with local drafts, exact operator review, durable execution phases, bounded logs, selected file transfers and independently confirmed cleanup. The model can propose a command and read recorded results, but cannot approve cloud spending. Daytona has its own pause control; cleanup remains active while paused. See [Daytona qualification](mira-daytona.md) for admission limits, explicit environment settings and the required live qualification before activation.

### Local code execution adapter

The same check image includes a local Docker transport for fixed Homelab source inspection, patches and structured edits. It reuses the Daytona verification harness, Bun version, PostgreSQL fixture and result format. Main jobs use the existing durable job table, draft/approval functions, attachment store and publication provenance. The trusted browser host runs the code dispatcher independently of browser work. Chat, Automations and task Run share the Code execution selector; existing settings remain Daytona until explicitly changed, and every run freezes its choice. Code jobs displays both targets, including exact-target approval, logs and results. See [deployment configuration](../deploy/README.md#optional-local-code-execution) before activation; production remains unchanged by publication.

Every job records its execution target. Existing rows remain Daytona jobs, and its worker/recovery controls cannot claim Main work. Main approval explicitly confirms the target, exact fixed-profile content, input digests and current `code:main` consent. Consent is tied to the owner, original host UUID, immutable image and dedicated network. The host must maintain its nonsecret heartbeat while dispatching; a missing heartbeat or changed consent stops execution. No Daytona credential is needed, no automatic fallback occurs, and dashboard-improvement jobs remain excluded until their policy supports target selection.

Both targets share the existing single-active-job admission limit; only cloud admissions consume Daytona's daily attempt allowance. The local dispatcher renews a fenced lease while running, rechecks pause/cancellation and records each lifecycle transition conditionally. Interrupted attempts reconcile against the original host and image without rerunning the check. Uncertain cleanup keeps capacity reserved. Results are stored only after confirmed container removal, and a lost final commit response cannot downgrade committed results. Integration tests exercise this queue with a disposable PostgreSQL database and synthetic container boundaries; the image qualification below tests the actual transport.

The trusted host selects an immutable image and a dedicated isolated network using the existing public-egress proxy. The model and dashboard never receive the Docker socket. A check has no host mounts, published ports or provider credentials, runs as the image's non-root PostgreSQL user, and uses bounded CPU, memory, temporary storage and processes. The existing fixed check profile has a ten-minute deadline; the container's eleven-minute outer limit includes setup and transfer. The host execution deadline starts immediately before container startup, after separately bounded creation and authorization. This does not change Daytona's renewable idle lifetime for ordinary cloud jobs.

Input and output pass over bounded private stdio. The host journals creation before contacting Docker, records its immutable receipt before startup, rechecks authority through the caller's startup fence, and removes the container before returning output. Each lifecycle write has its own ten-second journal deadline. Execution writes also race caller cancellation; cleanup writes remain independent of it and continue to removal when storage stalls. Docker operations do not consume the final cleanup acknowledgement's deadline. Journal implementations must use the supplied deadline and conditional phase/lease writes so late acknowledgements cannot revive a retired attempt. Lost acknowledgements are never replayed. Recovery checks the original image and owner before removal; uncertain absence retains capacity. A failed database journal still permits removal of a verified owned container but cannot report cleanup as recorded.

`scripts/smokeLocalCode.py` qualifies the actual image, proxy, source retrieval, input/output transfer, interruption and recovery without Daytona access. The image CI reuses its existing full harness test and adds this short transport qualification. Optional `--full` also runs the full verification profile locally when qualifying the adapter or its network path.

### Browser host supervision

The private `openMiraBrowserSession` binding consumes an owned manual-run grant and snapshots its owner and executor lease. The returned port contains no private host token. It checks authority before and after every operation, polls while starting or idle, and expires the last permit independently when a database check stalls. Query time consumes the permit; no reply can renew expired or permanently cancelled access. Commands are serial and uncertain input is never replayed.

A native disconnect, human stop, revoked run or expired permit cancels the whole browser lifetime. Cleanup waits for container removal before closing the durable grant. A failed factory that never returned a cleanup-capable port, failed container removal, or failed database release keeps the slot reserved for reconciliation. Automatic retirement exposes a `closed` promise so the trusted host can retain and report that failure.

This binding is not a deployed host daemon or a model-facing tool. The durable process registry and local Docker reconciliation are connected to this host boundary. A deployed service loop, command transport and network egress enforcement remain required before live activation. No Docker socket is given to the Mira agent or browser container. Existing native qualification now checks automatic revocation against actual Chromium and independently proves the container is absent before the claim-release callback runs.

### Durable browser process registry

The private registry reserves at most two unfinished browser processes across all hosts. Each claimed human grant can create only one process record. The record fixes a random container name/owner identity, persistent host ID and immutable image ID before any Docker mutation. A private controller lease lasts fifteen seconds; creation and renewal also require the original live browser grant. These database leases do not independently authorize browser input.

A host must commit `creating` before issuing its single create request and record the returned immutable container ID afterward. Restart recovery only takes expired records for the configured local host, rotates the controller token and permanently switches the grant to cleanup. Expired or replaced controllers cannot resume creation. The original controller can still request cleanup after its run expires until recovery replaces it.

Cleanup releases the process slot and human grant atomically. A never-dispatched reservation can close without a container. A settled Engine create rejection is journaled separately and can close after verifying that its generated name is absent. A known returned container can close after verified removal or verified absence of that exact ID. An uncertain create cannot close merely because inspection returned not found: it requires an ownership-verified container removal. Failed or unconfirmed cleanup retains capacity. The existing grant cleanup helper rejects bypassing an unfinished registry record.

The host now reserves this record before Docker work and uses its UUID for the container name and owner label. It commits create intent before dispatch, records the returned immutable ID before attachment/startup, and renews process ownership alongside every periodic and action-specific grant check. A replaced or expired controller cannot continue startup or input. Cleanup fences execution before removal and closes the process and original human grant only after verified absence. Cancellation during a committed create settles that single stopped container and removes it without starting a browser.

`recoverMiraBrowserProcesses` rotates expired local controller claims and reconciles at most two processes per invocation. It verifies the original image, owner label and known container ID, persists a newly discovered ID before deletion, uses the recorded image even after an update, and never attaches, starts or replays work. Failed cleanup and unknown creation plus not-found retain capacity. An observed late container can be removed safely and then release that slot. The caller receives recovered/unresolved counts; private controller tokens remain inside the host.

The service loop, command queue, network egress, operator controls and production activation remain separate work. No Docker socket or registry endpoint is exposed to the model. Qualification covers the database and private HTTP/stream lifecycle together, plus actual Chromium teardown and recovery through the Docker engine.
