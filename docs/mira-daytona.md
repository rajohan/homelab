# Daytona cloud jobs and qualification

Mira exposes direct code operations and recorded results through the existing
isolated executor. Use `mira_code_read_sources`, `mira_code_edit` and
`mira_code_check`, then inspect `mira_code_result`. Fixed local work needs no extra
human approval in manual Chat. Cloud work retains its current permission and
resource requirements. Automatic improvements use their separate explicit policy.

## Operator workflow

Request the code work in Chat. The same call validates inputs, records the exact
operation and queues it when permitted. If cloud execution needs a human decision,
a concrete request appears above the composer. No separate draft workspace or
manual start step is needed for covered work. Durable execution records, logs,
artifacts, cancellation and cleanup remain in the existing dispatcher. A queued
operation is not a completed check; inspect the actual outcome.

Each input is at most 1 MiB, belongs to the signed-in owner and is fingerprinted before approval. Chat-proposed inputs must already be attached to that conversation. Input files remain protected from deletion while queued or active. The sandbox paths are `/tmp/homelab-mira/<job-id>/inputs/<name>` and the corresponding `outputs/<name>`. Selected results are imported through the existing immutable attachment store with its ownership, content-type and storage quotas. Generated results are passive UTF-8 text, PDF or PNG/JPEG/WebP; binaries and archives are not executed or extracted. Results stay available after the sandbox is deleted. Mira can read selected text/PDF outputs through the existing bounded attachment reader, restricted to jobs owned by the same conversation owner and linked to that conversation. Local recorded results remain readable while Daytona is paused. Images remain available for dashboard preview or explicit attachment to a new message.

The dispatcher has its own loop; neither model turns nor infrastructure light workers are occupied while cloud work runs. One globally active or unresolved sandbox is admitted at a time, with at most four admitted attempts per rolling 24 hours across bindings. Failed preflight attempts also count. These are resource-admission bounds, **not a currency budget** or a cap on activity performed outside Mira. Confirm provider pricing, available credits and billing controls before activation.

A job's command outcome, exit code and sandbox cleanup are separate. Cancellation, timeout, permission changes or unknown writes lead to whole-sandbox cleanup. An acknowledged deletion alone does not mean cleanup completed. Unknown creation followed by a 404 retains the admission slot and is shown as needing attention; Mira never creates a replacement automatically. Removing credentials blocks cleanup visibly. Restore a credential for the original organization; the persisted original snapshot/region binding is retained. Pause stops work while cleanup continues. Missing or oversized logs are explicitly marked incomplete, and unavailable selected artifacts make the result need attention.

## Daytona v2 setup

New jobs that select Daytona use its v2 Linux sandbox API. Main remains the default for new chats. Settings → Integrations distinguishes an absent owner binding, a provisioned integration that needs setup, and a qualified executor. Existing v0 jobs retain their original IDs and cleanup path.

Use a dedicated personal Daytona organization and its default project. The v2 project API key can prove single-user ownership through the read-only migration summary. Collaborative organizations require an interactive token to list members, so this integration cannot establish the same sole-owner condition there. The executor never receives an interactive sign-in token.

Configure the following in the dashboard and executor. The Compose overlay passes the settings through from the host's secret configuration:

- `HOMELAB_MIRA_DAYTONA_OWNER` selects the Homelab owner subject.
- `HOMELAB_MIRA_DAYTONA_ORGANIZATION_ID` and `HOMELAB_MIRA_DAYTONA_PROJECT_ID` specify the exact v2 organization and project.
- `HOMELAB_MIRA_DAYTONA_IMAGE_ID` selects an immutable Linux `img_…`. `HOMELAB_MIRA_DAYTONA_TARGET` is the concrete host region, as returned on an allocated sandbox.
- To use an official base image, also set `HOMELAB_MIRA_DAYTONA_PLATFORM_SOURCE` to its full `docker.io/daytonaio/<repository>@sha256:<digest>` registry source on **both** services. Use the v2 image search with `platform=true` and the exact ID. The executor checks the unique result, ID, publisher, registry digest, Linux class and ready/current format before allocation. No project image import, conversion or retention is needed. With the source left unset, the existing private-image path requires a ready, converted project image.
- `HOMELAB_MIRA_DAYTONA_TRUST_BOUNDARY=dedicated-organization` and `HOMELAB_MIRA_DAYTONA_NETWORK_ACCESS=provider-default` record the approved trust and networking configuration.
- Only Mira receives `HOMELAB_MIRA_DAYTONA_API_KEY`. Use a v2 project key with `read:images`, `read:sandboxes`, `write:sandboxes` and `delete:sandboxes`. Use the provider's read-only `GET /api-keys/current` to verify the key's project and organization. An HTTP 401 means the credential cannot authenticate to v2.
- After verifying the selected image, resource limits, network policy, command behavior, artifact handling, cancellation, deletion and billing for this project, run `bun --no-env-file /app/mira/qualification.js` in the matching packaged Mira environment. It prints the nonsecret hash without a provider request. Set executor-only `HOMELAB_MIRA_DAYTONA_QUALIFIED_BINDING_HASH` to this value and enable the changed binding in Settings. The platform fingerprint includes the bootstrap, check profile and Bun package integrity. Requalify when any of them changes. A dashboard version bump alone preserves the qualification. Rotating the API key within the same project and permissions also preserves it.

Migrated snapshots can exist on v2 as named images. Check the image record's `imported_from.id` against the original v0 snapshot ID and obtain its immutable v2 image ID. The original `HOMELAB_MIRA_DAYTONA_SNAPSHOT_ID` identifies the legacy mapping while migrating. Never substitute a v0 snapshot UUID for a v2 image. An unchanged legacy setup can still reconcile existing attempts. Finish existing cleanup in its original organization before moving credentials or projects.

[Official v2 migration guide](https://www.daytona.com/docs/migrate-from-v0) · [v2 project API keys](https://www.daytona.com/docs/api-keys) · [v2 sandboxes](https://www.daytona.com/docs/sandboxes)

Official platform sandboxes request Linux AMD64 and the named non-root user `nobody`. The executor checks the observed user and runs commands with Linux `no_new_privs`. General commands use the tools supplied by the image. A canonical Homelab check, edit or source request additionally receives the release-built public bootstrap as a separate file (up to 256 KiB). Its command verifies the file's owner, canonical path and SHA-256 before execution. The bootstrap installs the release's bundled check code, profile and Linux x64 Bun into the attempt directory. It fetches only the fixed npm tarball over HTTPS, checks the lockfile SHA-512 before extracting one regular executable, and verifies the Bun revision before invoking the check. The bootstrap and the check share the process deadline. Qualification therefore requires Python 3, Git, glibc, `setpriv` and HTTPS access to npm and the public source repository in the selected image.

## Execution and recovery

The dispatcher checks the API key's project, organization, expiry and permissions on the fixed `https://api.daytona.com` origin. Before a write it also checks the dedicated account and image binding. Creates request a Linux sandbox with 4 CPU, 8 GiB memory, 10 GiB disk, no additional environment, ports, volumes or secrets, and a five-minute idle-delete policy. The qualified executor renews the idle timer for approved work. Each create carries its durable attempt ID as the provider's idempotency key. Unknown acknowledgements are never replayed. A search by binding and attempt labels can recover the original sandbox. A missing search result after an uncertain create keeps the original admission reserved.

The executor validates the observed sandbox, then obtains a short-lived, single-sandbox access token limited to the exact file or execution capability. Only that token reaches the verified regional toolbox. The project key stays on the control plane. Transfers use the existing approval, 1 MiB file limits and fixed input/output directories. The executor submits the reviewed process once and checks its recorded process ID, attempt tag and command fingerprint on status and log reads. Log pages and response bodies are bounded. A separately confirmed deletion closes the cleanup record.

For v0 records, the original bounded control-plane and toolbox transports remain available for reconciliation; an old approval cannot start new v0 execution. Missing credentials, a different project, an unqualified image or pending cleanup are visible in the job or integration state.

## Unresolved cleanup recovery

A missing sandbox without a recorded deletion attempt does not release capacity automatically. In Cloud job details, **Resolve cleanup** shows the original organization, region, snapshot, sandbox name and any acknowledged sandbox ID, even if current configuration or credentials have been removed.

Pause Daytona without a scheduled resume, wait for the last activity deadline plus five minutes and any cleanup lease to expire, then verify in the original Daytona organization that the sandbox has been removed and no creation is pending. Type its exact name, record how removal was verified and confirm the external inspection. The server rechecks the persisted identity, pause, deadline, phase and lease atomically with global admission. A discovered sandbox ID invalidates an earlier review. This is an operator attestation, not proof provided by the API; do not use it when resource state is still unknown.

Resolution stops retries and releases local admission, keeps Daytona paused, records the human actor/time/note and a `daytona.cleanup_resolved` audit event, and labels cleanup **Confirmed by operator**. It does not contact Daytona, delete resources, reset the rolling attempt count or turn an unknown execution into success. Late workers lose their lease token. Existing cancellation is retained; otherwise the job remains `needs_attention`. The record is readable after resolution. Models and service principals cannot resolve cleanup. Existing provider-confirmed cleanup remains distinct.

## Fixed Homelab check profile

`mira_code_check` prepares an ordinary reviewed Cloud job for one exact
40-character public Homelab commit and, optionally, one patch text file already
attached to that conversation. It cannot choose another repository, approve a
job, provision resources, publish a branch or deploy. The existing pause,
qualification, exact-content approval, admission and cleanup controls still apply.
The job runs the immutable snapshot's `/opt/homelab/daytona-check.js`; a generic
Bun image is insufficient. Arbitrary Cloud commands remain a separate existing
operator-reviewed capability.

The harness uses the pinned Bun revision, a frozen install without lifecycle scripts, and no database. Its fixed steps are `check`, both migration metadata checks and `build`. Source is fetched by
exact SHA from the public repository without credentials, Git hooks, recursive
submodules or redirects. A selected patch is bounded to 1 MiB, hashed against the
reviewed input and applied with Git's indexed path checks. No host directory,
GitHub token, provider key or production database is available inside the image.
The fixed check command retains its ten-minute execution limit. The executor renews
provider activity while it runs; the sandbox has no universal fifteen-minute limit.
Before a write, the toolbox requires at least thirty seconds of idle headroom and
rechecks that window after authorization. Ordinary subprocess groups are terminated on interruption; provider
resource destruction is still independently confirmed by the dispatcher.

Each attempt uses fresh directories and refuses replay. It returns
`check-result.json`, `check-log.txt` and `changes.txt` (the normalized selected
patch, not a newly generated change). Logs and files are bounded. Preparation and
check failures return a nonzero exit status; when preparation has created the
output directory, the report records incomplete steps.
An image/profile mismatch can fail before artifacts exist. Repository code can
alter its own sandbox, so reports remain explicitly **untrusted sandbox results**,
never evidence that authorizes automatic GitHub writes, merge or deployment.
The profile does not run image builds or provider qualification inside itself.

`deploy/Dockerfile` builds the shared Main image, including the fixed code harness.
The release workflow publishes this image once in the `dashboard` registry package.
`daytona-image.json` keeps the logical `daytona-check` role but points to that same
immutable `dashboard` reference for the private-image option. The official platform
option uses Daytona's own image and installs the bounded public tools for each fixed job.
Dependabot proposes Docker base updates through normal reviewed PRs. Snapshot
activation in Daytona remains explicit; importing a release must preserve the
configured resources and fixed runtime.

Build the local image on Linux AMD64:

```sh
docker build -f deploy/Dockerfile --build-arg APP=homelab -t homelab-daytona-harness:local .
```

The repository no longer ships a smoke-test harness. After an authorized snapshot
update, use the existing Chat code-execution controls for one fixed Homelab check
and inspect its recorded output and cleanup. A local build alone does not verify
Daytona allocation, provider networking or cleanup.

## Structured code edits

The version 2 snapshot also supports `mira_code_edit`. Mira can use
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
`mira_code_read_sources` first prepares source inspection at that same exact
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
