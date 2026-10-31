# Daytona cloud jobs and qualification

Mira provides reviewed cloud-job drafts, a durable independent dispatcher and shared dashboard status, logs, results and cancellation. Chat tools can propose jobs and read recorded results; they cannot approve or execute commands. [Automatic frontend improvements](mira-improvements.md) use a separate explicit operator policy to queue only the fixed structured-edit check. Production activation and live account/snapshot qualification remain outstanding. Publishing this code does not provision a paid sandbox.

## Operator workflow

Open **Cloud jobs** in Chat or on the Jobs page. Save a command and explicitly select up to four input files and four output filenames. Review the exact command and transfer list, then choose **Start cloud job**. The approval expires after fifteen minutes in the queue. Changes to the command, account, snapshot, pause control or linked content require a new review. The review dialog freezes a displayed draft and disables starting if a newer version arrives.

Each input is at most 1 MiB, belongs to the signed-in owner and is fingerprinted before approval. Chat-proposed inputs must already be attached to that conversation. Input files remain protected from deletion while queued or active. The sandbox paths are `/tmp/homelab-mira/<job-id>/inputs/<name>` and the corresponding `outputs/<name>`. Selected results are imported through the existing immutable attachment store with its ownership, content-type and storage quotas. Generated results are passive UTF-8 text, PDF or PNG/JPEG/WebP; binaries and archives are not executed or extracted. Results stay available after the sandbox is deleted. Mira can read selected text/PDF outputs through the existing bounded attachment reader, restricted to jobs owned by the same conversation owner and linked to that conversation. Local recorded results remain readable while Daytona is paused. Images remain available for dashboard preview or explicit attachment to a new message.

The dispatcher has its own loop; neither model turns nor infrastructure light workers are occupied while cloud work runs. One globally active or unresolved sandbox is admitted at a time, with at most four admitted attempts per rolling 24 hours across bindings. Failed preflight attempts also count. These are resource-admission bounds, **not a currency budget** or a cap on activity performed outside Mira. Confirm provider pricing, available credits and billing controls before activation.

A job's command outcome, exit code and sandbox cleanup are separate. Cancellation, timeout, permission changes or unknown writes lead to whole-sandbox cleanup. An acknowledged deletion alone does not mean cleanup completed. Unknown creation followed by a 404 retains the admission slot and is shown as needing attention; Mira never creates a replacement automatically. Removing credentials blocks cleanup visibly. Restore a credential for the original organization; the persisted original snapshot/region binding is retained. Pause stops work while cleanup continues. Missing or oversized logs are explicitly marked incomplete, and unavailable selected artifacts make the result need attention.

## Version and transport

Mira pins the official `@daytona/api-client` at `0.226.1` in its Bun workspace. The existing weekly Bun Dependabot group includes it; dependency changes follow the existing `chore(deps)` patch-release policy. No third-party package is patched. The generated request-parameter builders provide the current API routes and typed payloads; Homelab sends those requests using its bounded fetch transport. It does not instantiate the high-level SDK, inherit its dotenv configuration, initialize telemetry or start background sockets. Requests use the fixed `https://app.daytona.io/api` origin, reject redirects, omit cookies, cap metadata at 256 KiB and bound headers plus body delivery to 15 seconds. They are not automatically retried.

The reviewed official SDK `0.226.1` uses connection retry rules, automatic environment discovery and optional telemetry. Its explicit `otelEnabled: false` does not override an environment value of `true`. The generated client avoids importing those runtime behaviors without a local patch. See the [official clients](https://github.com/daytona/clients) and [Daytona API](https://www.daytona.io/docs/en/api/).

## Provisioning contract

The dashboard and executor read the nonsecret binding from these explicit settings. `deploy/compose.mira.yaml` carries them to each service; only the executor receives the credential and qualification value:

- `HOMELAB_MIRA_DAYTONA_TRUST_BOUNDARY`: must explicitly be `dedicated-organization`. The operator must provision an organization used only by Mira, retain its own trusted owner access and revoke keys distributed to other applications or people. This is a provisioning requirement, not a claim that API-key authentication can enumerate every key.
- `HOMELAB_MIRA_DAYTONA_NETWORK_ACCESS`: must explicitly be `provider-default`. Network access is allowed for build dependencies; no deny-all guarantee is made.
- `HOMELAB_MIRA_DAYTONA_OWNER`: Homelab owner subject.
- `HOMELAB_MIRA_DAYTONA_ORGANIZATION_ID`: exact provider organization UUID.
- `HOMELAB_MIRA_DAYTONA_SNAPSHOT_ID`: exact private snapshot UUID, not a mutable name or default image.
- `HOMELAB_MIRA_DAYTONA_TARGET`: selected provider region.
- `HOMELAB_MIRA_DAYTONA_API_KEY`: executor-only credential. It never enters the model environment, persisted binding or sandbox payload.
- `HOMELAB_MIRA_DAYTONA_QUALIFIED_BINDING_HASH`: explicit operator qualification receipt equal to `daytonaBindingHash(binding)`. Leave unset until the dedicated organization, trusted owner access, clean immutable Bun 1.4.4 snapshot, command behavior, output limits, cancellation, idle cleanup and billing controls have been qualified. It is an attestation gate, not an automated snapshot inspection or a secret. Changing the bound snapshot/region/policy invalidates execution qualification; credentials remain available for cleanup.

Before creation, `/api-keys/current` must confirm the configured organization, a live credential and both `write:sandboxes` and `delete:sandboxes`. A fresh membership read must confirm exactly one member of that organization: the credential creator, in the owner role. Failure, missing data or another member prevents creation before the admission callback. The organization-details endpoint rejects API-key authentication on the live service, so it is not used as a prerequisite and the executor does not receive an interactive session credential. Daytona enforces account suspension, available credits and provider limits when processing resource requests. A rejected creation remains an uncertain attempt and follows the existing reconciliation path; preflight is not a billing or availability guarantee. Cleanup does not depend on the creation-only membership check. The private snapshot must belong to that organization, be active, use the container class, and declare exactly 4 CPU, 8 GiB memory, 10 GiB disk and no GPU. An immutable, clean snapshot with Bun 1.4.4 and qualified command execution must be provisioned and checked before activation. A dedicated bounded coding harness and automatic improvement policy remain a separate qualification step; this delivery supports individually reviewed commands. Metadata alone does not prove the installed Bun version or absence of baked-in secrets. No live snapshot has been qualified by this change.

Create requests inherit those resource limits from the verified snapshot and specify no volume mounts, no linked sandbox, no mounted secrets, no host environment, no KVM, private previews and `networkBlockAll: false`, with no sandbox allow list or proxy. This deliberately permits provider-default outbound networking for package installation. Tier 1/2 allow essential services; Tier 3/4 may allow the full internet. There is no inferred deny-all boundary and no tier upgrade is requested. Only explicitly approved inputs may enter this environment; host credentials, production data and unrelated files must never be exported. See [Daytona network limits](https://www.daytona.io/docs/en/network-limits/). A future strict-network mode must independently qualify the effective policy before use.

[Daytona runtime access](https://www.daytona.io/docs/en/api-keys/) is organization-wide, regardless of key resource scopes. `private` prevents public preview access; labels identify an attempt within the trusted organization and do not isolate it from other organization credentials. Runtime deployment therefore requires the dedicated-organization provisioning contract above. The owner must not share keys or add members while jobs are active. The adapter checks sole-owner membership before creation, but an API key cannot prove absence of other keys: manager-key listing only returns that manager's children. Do not introduce a false full-inventory check or grant the executor key-management privileges. Document and qualify existing owner sessions and keys before activation; pause admissions and revoke unused keys when this boundary changes.

The network choice and organization trust contract are included in the binding fingerprint. Credential rotation within the same organization preserves it.

Policy version 2 uses 4 CPU and 8 GiB memory with the same 10 GiB disk limit.
The changed policy and snapshot require a new qualification fingerprint. Finish
and confirm cleanup of existing jobs before replacing a deployed policy; do not
use a new fingerprint to identify old resources.

The provider receives a five-minute idle-stop interval and immediate deletion after stop, with no wall-clock TTL. The executor explicitly refreshes activity at most once per minute while the owned job is authorized and its activity window has not expired. Background commands do not refresh Daytona activity by themselves. Finished, cancelled and failed jobs enter the existing deletion flow; if the executor disappears, provider idle-stop/delete is the independent fallback. [Daytona's lifecycle contract](https://www.daytona.io/docs/en/sandboxes/#automated-lifecycle-management) distinguishes idle activity from TTL. The feature-gated queue timeout is omitted: accounts without that feature reject creation when it is present. Resource sizing is inherited from the verified snapshot; the create request must not duplicate its CPU, RAM, disk or GPU fields. The durable dispatcher enforces the admission limits above. Provider billing still requires account qualification; this adapter does not enforce a currency budget or a maximum duration for an authorized active command.

## Caller obligations and recovery

The durable dispatcher persists the immutable binding, a unique attempt UUID and create-attempt state in the final `authorize` callback before it returns and dispatch occurs. The callback must atomically recheck owner controls, lease, approval/admission policy and concurrency/spend limits. Call `create` at most once for that attempt. The adapter performs account/snapshot preflight before this callback and immediately returns the create receipt without waiting for readiness. Persist the returned provider ID before any subsequent step.

A deterministic `mira-<binding-prefix>-<attempt-UUID>` name and full binding/attempt labels allow `inspect` to find an already created sandbox after an acknowledgement is lost. Account, name, labels and any recorded provider ID must all agree before accepting an observation or sending DELETE. A timeout, cancellation during dispatch, HTTP error or malformed mutation response produces `DaytonaUncertainMutation`; it must never return to an automatic create/replay path. Even a subsequent 404 does not prove that a timed-out creation cannot still appear. Retain unresolved attempts for reconciliation through their expected lifetime and report uncertainty rather than freeing the admission slot early.

`settingsMatch` means the observed environment is explicitly empty and the requested resource, preview, networking, region, snapshot and remaining idle-activity fields match. Missing or nonempty `env` fails the check, including opaque provider secret placeholders. A custom `otelEndpointOverride` also fails the check: sandbox telemetry must use the provider's default collector, with the override absent, null or empty. The endpoint is never exposed in observations. This is metadata comparison, **not execution readiness, exclusivity proof or a network containment guarantee**. Callers must also perform a fresh `preflight(signal, true)`, enforce the dedicated-organization provisioning policy, require `state === "started"`, and qualify the runtime before code execution. The toolbox adapter remains internal to the leased dispatcher, never directly exposed to a model. Unknown states are observations, never success. Missing or drifted settings do not block deletion of a resource whose identity remains verified. Snapshot lookup failure similarly cannot strand cleanup. Retain the original binding for cleanup after the active configuration changes.

`destroy` distinguishes an absent resource, a confirmed `destroyed` state and a merely accepted deletion request. A successful DELETE request is not completion. Poll until absence/destruction is confirmed; uncertain DELETE responses retain the known provider ID. Cleanup must remain possible while new admissions are paused, and provider idle-stop/delete is the fallback if the executor disappears. No host command execution, SSH keys, credentials or private repository export is provided by this adapter.

Daytona prefixes sandbox names with `DESTROYED_` and appends a timestamp when
deletion starts. Reconciliation accepts this provider rename only in `destroying`
or `destroyed` state with the exact persisted sandbox ID, expected original name,
organization and ownership labels. It never authorizes creation, a name-only
lookup or execution against a renamed resource.

## Validation

Synthetic tests exercise account, membership and snapshot disagreement, final admission revocation, cancellation before and during dispatch, uncertain writes with no replay, deterministic recovery, cross-owner/ID rejection, policy drift, cleanup during snapshot outages, explicit deletion outcomes, private response-field omission, and advertised/streamed response limits. These tests use the actual generated request builders and an injected provider transport. They incur no Daytona usage and do not replace later live qualification.

## Bounded command and file transport

The toolbox pins the paired official `@daytona/toolbox-api-client` at `0.226.1`. It uses generated request builders and the fixed `https://proxy.app.daytona.io/toolbox/<persisted-sandbox-UUID>` origin, never a URL supplied by the provider, a model or a file. It advertises `X-Daytona-SDK-Version` from the installed toolbox package metadata so command logs use the documented structured response. It does not instantiate the high-level SDK, open following sockets or retry writes. No host command, local filesystem path, environment or credential is passed to the sandbox. See [Daytona process sessions](https://www.daytona.io/docs/en/typescript-sdk/process/) and [file operations](https://www.daytona.io/docs/en/typescript-sdk/file-system/).

Each attempt has one deterministic session and at most one submitted command. `open`, `upload` and `submit` independently perform fresh account/membership and sandbox identity/settings checks, then invoke a final caller-owned authorization callback immediately before their external write. At least 30 seconds of the current idle window must remain before a write; the observed absolute expiry is rechecked immediately after the final authorization callback, before dispatch. These callbacks must atomically check owner access, control versions, live lease, phase, exact content approval and limits, and persist each unique phase attempt **before dispatch**. The caller must serialize upload/session/command phases; a provider read is not a lock. Do not use this low-level interface directly as a model tool or treat possession of the API key as user consent.

`submit` accepts at most 16 KiB of well-formed UTF-8 command text, without normalization or host shell interpolation. It requires an acknowledged empty session, requests asynchronous execution and suppresses command input echo. Persist the returned command ID immediately. `inspect` verifies the exact command fingerprint and any known ID, rejects additional/replaced commands, and reports absent, empty, running or completed. Any exit code, including nonzero, is a completed command observation, not necessarily a successful job. Neither an absent nor an empty session authorizes reissuing a command after an uncertain dispatch. A lost response, invalid receipt, provider error or cancellation during any write raises an uncertain result; the durable caller must reconcile the same attempt or destroy its sandbox. Aborting an HTTP request does not stop remote code. Cancellation and timeout must therefore trigger the separately verified sandbox destruction lifecycle; session deletion is not relied upon as process termination.

Log reads verify command identity first and explicitly request `follow=false`. A response is capped at 256 KiB, each log field at 65,536 characters and the combined returned UTF-8 text at 128 KiB. Oversized logs fail explicitly instead of being reported as complete or silently truncated. Individually reviewed commands should bound their generated output so useful logs remain retrievable; a separate bounded coding harness remains to be qualified. Log text is untrusted content for plain-text rendering, never HTML or instructions.

Uploads accept only supplied in-memory bytes, copy them before asynchronous work and cap each at 1 MiB. Relative ASCII names are confined lexically to `/tmp/homelab-mira/<attempt>/inputs/`; uploads are refused once a command is observed. Uploads preserve the generated multipart `file` part, with fetch supplying its matching boundary. The provider must acknowledge the exact destination. Downloads request one explicitly selected relative name under the corresponding `outputs/` directory, return at most 1 MiB of untrusted bytes and never write or extract files on the host. Parent directories, absolute paths, query fragments and encoded separators are rejected. This is path selection, not a claim that the provider filesystem prevents symlink following or that a cloud artifact is trustworthy. Only the clean, dedicated, qualified sandbox may supply artifacts; the durable product layer must authorize exact output selections and enforce total file/count/storage limits before importing into the existing attachment pipeline. It must not execute returned bytes.

The durable queue records each create/session/upload/command attempt before the external write. A ninety-second phase lease fences concurrent dispatchers and each provider phase has a sixty-second cancellation bound. A recovered ambiguous write phase goes to cleanup instead of replay. The persisted deadline is a rolling five-minute activity window, not a total job duration. Refresh rechecks consent, ownership, pause, cancellation and the live phase lease immediately before dispatch. It records the possible new idle deadline before the provider request so an ambiguous acknowledgement cannot release capacity early. Expired activity is never revived. Selected file IDs are stable across import retries, and changed bytes cannot overwrite a previously accepted artifact. Synthetic PostgreSQL, transport and component tests exercise these transitions and exact review semantics without creating paid resources.

Still required before paid production activation: dedicated-account and immutable-snapshot qualification, provider billing/credit checks, a live end-to-end cancellation/idle-cleanup/artifact exercise and the explicit operator qualification receipt. A bounded coding harness, unattended improvement spending policy and production cutover are not delivered by this PR. Saving a draft does not change a provider account, key, snapshot or paid resource. Starting the executor may resume previously approved queued jobs; production qualification must therefore precede activation.

## Unresolved cleanup recovery

A missing sandbox without a recorded deletion attempt does not release capacity automatically. In Cloud job details, **Resolve cleanup** shows the original organization, region, snapshot, sandbox name and any acknowledged sandbox ID, even if current configuration or credentials have been removed.

Pause Daytona without a scheduled resume, wait for the last activity deadline plus five minutes and any cleanup lease to expire, then verify in the original Daytona organization that the sandbox has been removed and no creation is pending. Type its exact name, record how removal was verified and confirm the external inspection. The server rechecks the persisted identity, pause, deadline, phase and lease atomically with global admission. A discovered sandbox ID invalidates an earlier review. This is an operator attestation, not proof provided by the API; do not use it when resource state is still unknown.

Resolution stops retries and releases local admission, keeps Daytona paused, records the human actor/time/note and a `daytona.cleanup_resolved` audit event, and labels cleanup **Confirmed by operator**. It does not contact Daytona, delete resources, reset the rolling attempt count or turn an unknown execution into success. Late workers lose their lease token. Existing cancellation is retained; otherwise the job remains `needs_attention`. The record is readable after resolution. Models and service principals cannot resolve cleanup. Existing provider-confirmed cleanup remains distinct.

## Fixed Homelab check profile

`mira_daytona_check_draft` prepares an ordinary reviewed Cloud job for one exact
40-character public Homelab commit and, optionally, one patch text file already
attached to that conversation. It cannot choose another repository, approve a
job, provision resources, publish a branch or deploy. The existing pause,
qualification, exact-content approval, admission and cleanup controls still apply.
The job runs the immutable snapshot's `/opt/homelab/daytona-check.js`; a generic
Bun image is insufficient. Arbitrary Cloud commands remain a separate existing
operator-reviewed capability.

The harness uses Bun 1.4.4, a frozen install without lifecycle scripts, and native
PostgreSQL 18 bound to loopback. Its fixed steps are `check`, both migration
checks, `test`, `test:integration`, `build`, and `test:smoke`. Source is fetched by
exact SHA from the public repository without credentials, Git hooks, recursive
submodules or redirects. A selected patch is bounded to 1 MiB, hashed against the
reviewed input and applied with Git's indexed path checks. No host directory,
GitHub token, provider key or production database is available inside the image.
The fixed check command retains its ten-minute test timeout. The executor renews
provider activity while it runs; the sandbox has no universal fifteen-minute limit.
Before a write, the toolbox requires at least thirty seconds of idle headroom and
rechecks that window after authorization. Ordinary subprocess groups are terminated on interruption; provider
resource destruction is still independently confirmed by the dispatcher.

Each attempt uses fresh directories and refuses replay. It returns
`check-result.json`, `check-log.txt` and `changes.txt` (the normalized selected
patch, not a newly generated change). Logs and files are bounded. Preparation and
check failures return a nonzero exit status; when preparation has created the
output directory, the report records incomplete steps and local database cleanup.
An image/profile mismatch can fail before artifacts exist. Repository code can
alter its own sandbox, so reports remain explicitly **untrusted sandbox results**,
never evidence that authorizes automatic GitHub writes, merge or deployment.
The profile does not run image builds or provider qualification inside itself.

`deploy/daytona/Dockerfile` is the versioned snapshot recipe. The **Daytona check
image** workflow builds and tests the actual non-root image with no host mounts,
then publishes the same tested image on stable releases. `daytona-image.json`
records the immutable registry reference separately from the three service
images. Dependabot proposes Docker base updates through normal reviewed PRs.
A new image release does not silently replace the configured snapshot: import the
recorded digest into the dedicated Daytona organization, verify the fixed
resources and runtime, exercise outputs/cancellation/idle cleanup/deletion on that exact
snapshot, then renew the qualified binding hash. The updater can track the
versioned release artifact; snapshot activation remains an explicit qualified
operation. Do not mark an image or binding qualified solely because CI passed.

Local image qualification (Linux AMD64, Docker, public network access):

```sh
docker build -f deploy/daytona/Dockerfile -t homelab-daytona-harness:tested .
bun run test:daytona <exact-public-commit-sha>
```

This smoke test uses a read-only container with two CPUs, 4 GiB memory, bounded
process count and a 2 GiB temporary filesystem. It runs all fixed checks, verifies
all three artifacts and replay refusal, then removes the container. It does not
contact Daytona or consume provider credits. Live provider acceptance is still
required before production enablement.

## Structured code edits

The version 2 snapshot also supports `mira_daytona_edit_draft`. Mira can use
`mira_file_create` to attach a JSON edit plan to the current manual conversation,
then select that file as `editsId` in the draft. The operator reviews and starts
it through the existing Cloud jobs controls. This is an alternative to supplying
a ready-made unified patch; it uses the same fixed public repository, approval,
pause, resource limits, deadline and cleanup path.

```json
{
    "version": 1,
    "commit": "<exact public base commit: 40 lowercase hexadecimal characters>",
    "files": [
        {
            "path": "apps/dashboard/src/browser/example.ts",
            "beforeSha256": "<SHA-256 of the original file's exact UTF-8 bytes>",
            "content": "complete replacement text\n"
        }
    ]
}
```

Use `beforeSha256: null` only to create a file that does not exist, and
`content: null` to delete an existing file with its matching fingerprint. Empty
files are supported. Each plan must match the selected commit and contains up to
20 text files of at most 256 KiB each; both the plan and generated patch are capped
at 1 MiB. Paths are relative ASCII repository paths without whitespace, traversal,
`.git` segments, symlinks or special files. Existing executable modes, BOMs and
line endings are preserved; new files use mode 100644. Binary files, unchanged
replacements, duplicate/overlapping paths and stale original fingerprints fail
before application or repository scripts run. Split changes beyond these bounds.

The harness builds a patch without writing originals, then validates and applies
it through `git apply --check --index` / `git apply --index`. It runs the same
required repository checks and returns the normalized `changes.txt`, log and
report, including `inputEditsSha256`. These remain untrusted sandbox artifacts.
This prepares code changes for review; it does not publish a branch/PR, merge,
deploy, give the sandbox a GitHub credential, or enable scheduled code writes.
`mira_daytona_source_draft` first prepares source inspection at that same exact
commit. It returns `source-tree.json` and, for up to twenty selected paths,
`source-files.json` with the original UTF-8 text, mode and SHA-256. Select
`AGENTS.md` and applicable nested instructions along with the files being changed;
use an empty selection to discover the tracked tree. Missing files have null
content/mode/hash. Sources and the tree remain bounded to 1 MiB per artifact and
are untrusted context. Source inspection does not install dependencies, run
repository scripts or perform the verification suite. It follows the same normal
Cloud job review, admission, reservation and cleanup controls. The model can read
these returned artifacts using `mira_attachment_read`, then prepare the edit plan.
Automatic improvement permissions and GitHub publication remain separate work.

The image smoke test now exercises source inspection and a real structured edit, all required checks,
patch recovery and replay refusal in the bounded local container. Existing patch
arguments remain supported. The profile marker is `homelab-check-v2`, so importing
and qualifying the new immutable snapshot is required before using edit drafts;
a deployed version 1 snapshot must not be treated as compatible. No production
binding is changed by this repository update.
