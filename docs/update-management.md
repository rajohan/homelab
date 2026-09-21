# Update management

Reporting does not grant installation access. `updates.releases` remains read-only.
The worker registers installers only for explicit `HOMELAB_DASHBOARD_UPDATE_TARGETS`
or `HOMELAB_DASHBOARD_UPDATE_TARGETS_FILE` configuration.
All automatic policies default to **off**, including Docker and digest-pinned images.

## Authority and lifecycle

- `updates:read` reads inventory and policies. `updates:publish` can publish only the
  account's configured source; it cannot enable a policy or authorize an install.
- `updates:apply` plus `jobs:run` queues a confirmed candidate. Human requests also
  require recent step-up verification. Automation accounts require explicit scopes.
- `updates:configure` changes automatic policy and requires a recently verified human.
- Every request binds the source observation, versions, target and recipe to a digest.
  Native targets own their required `release` provider. Docker targets own their
  optional `trackingTag`; when omitted, only the installed image's own tag/flavor
  may be followed. A publisher's different provider or tracking override cannot
  authorize a manual or automatic install, even after a successful release lookup.
  The worker rechecks it immediately before execution. Individual queued authority expires after
  five minutes; a confirmed bulk host job has one hour of queue-wait time, excluding
  successful execution on the same host from the same confirmation. Expired work must be confirmed again. Changing a target invalidates its
  previous automatic consent. Disabling a policy stops queued automatic work, not an
  installation already executing on the host.
- Automatic admission accepts comparable stable patch/minor versions only. Majors,
  prereleases, downgrades, held packages, stale reports and unknown version schemes
  never become automatic installs. A Docker tag/digest pin is not a package hold.
- Installers use the existing queue, resource leases, audit trail, progress events,
  notifications and worker-activity UI. An installer has **one attempt**, not retries.
  A failed/expired automatic candidate is not silently requeued while its run remains
  in retained history. Hosts are never rebooted automatically.

## Bulk updates

The global **Update all** action and each source's **Update all** action open the same
confirmation plan. Source rows show the full available count, not the current page or
search results. The plan lists included and excluded software with exact versions and
reasons. Major upgrades require a separate individual confirmation; held, stale,
unverified and unconfigured targets are not silently installed.

Admission checks the complete plan revision in a transaction and queues one nonretryable
job per host/source. Work on different hosts may run concurrently; packages and
applications on each host run in sequence. A shared host lease prevents overlap with
individual installers, including targets using different source IDs for the same SSH
hostname. Configure one canonical hostname per physical host, shared by SSH update
targets and Docker control endpoints. Lifecycle admission adds only the selected
target's host key, which is rechecked against the worker's configuration before execution;
read-only inventory refreshes do not block installations. A failure stops the
remaining entries on that host, while other host jobs are independent. Every entry
rechecks its observation and target before execution. A package already installed at
the approved version by an earlier package dependency is verified without reinstalling.

Source aliases sharing a host do not expire merely because an earlier job in the same
confirmed plan ran for more than an hour. Only successful execution intervals from the
same actor, request, scope and plan revision count against queue-wait time; overlapping
intervals count once and idle gaps or unrelated jobs do not renew consent. A failed,
cancelled or timed-out sibling prevents the remaining same-host aliases from starting.

Each installation retains its 25-minute deadline. A host job gets that budget plus
30 seconds of coordination per entry and one minute of batch overhead, rather than
one fixed hour for the entire list. At most 395 entries per host fit the seven-day
absolute integration-job ceiling; larger confirmations are rejected before admission.
The seven-day ceiling applies only to code-owned, one-attempt, integration-only jobs;
ordinary jobs retain their one-hour maximum. Cancellation, lease loss, stale or changed
observations can still stop a batch; extra time does not extend update consent.
Deployments must apply the forward `bounded_batch_deadlines` migration before running
the new web/worker release. It widens only the existing job constraint for one-attempt,
non-retryable work and preserves existing jobs and history. Released migrations are unchanged.

## Deployment-owned targets

The versioned [target registry](../apps/dashboard/config/update-targets.json) is a
normal nonsecret JSON configuration file. It contains this installation's reviewed
hosts, paths, service owners, fixed recipes and secret-reference names. The dashboard
build copies it unchanged to `dist/config/update-targets.json`; the dashboard/worker
image includes it at `/app/config/update-targets.json`. Auth does not include it, and
the dashboard does not serve it as a browser asset or HTTP configuration endpoint.

Select it explicitly with
`HOMELAB_DASHBOARD_UPDATE_TARGETS_FILE=/app/config/update-targets.json` for **both**
dashboard and worker. Remove the legacy inline `HOMELAB_DASHBOARD_UPDATE_TARGETS`
setting rather than setting it to an empty value: specifying both fails startup.
Other installations can select their own absolute, read-only mounted JSON file or
continue using inline JSON. Missing files, symlinks, nonregular files, invalid UTF-8,
files exceeding 1 MiB and invalid target schemas fail closed without an inline fallback.

Shipping the file does not activate targets implicitly, provision access, enable
automatic policies or execute updates. Source publisher registration is still required.
SSH keys, tokens and secret values remain separately delivered to the worker only.
The environment-loader commands are fixed source code; their outputs are never part
of this file or image. They run on the target only when an approved update executes.

Changes to this registry follow the normal PR, release and image-deployment process.
Dashboard and worker must use the same artifact/configuration. File and inline loading
share schema defaults and target fingerprints, so switching formats alone does not
change consent; changing any effective target still invalidates previous consent.
Never copy a development checkout's file into production to bypass that release.
Qualify native ownership, updater capabilities and health checks before activation,
including a current tested PBS backup for Nextcloud. Existing automatic policies
remain off unless separately enabled by the operator.

Example nonsecret configuration; paths refer to separately provisioned, read-only
worker mounts. Do not put private key contents in this JSON or repository.

```json
[
    {
        "id": "example-web",
        "source": "example-host",
        "label": "Example web",
        "host": "example-host.internal",
        "user": "update-operator",
        "port": 22,
        "identityFile": "/run/secrets/update-identity",
        "knownHostsFile": "/run/secrets/update-known-hosts",
        "sudo": false,
        "driver": {
            "kind": "docker",
            "name": "example-web-1",
            "project": "example",
            "service": "web",
            "directory": "/srv/example",
            "file": "/srv/example/compose.yml",
            "imageFile": "/srv/example/web/compose.yml"
        }
    }
]
```

An APT target uses `"driver": {"kind":"apt"}` and owns the source's APT packages.
A native target uses `kind: "native"`, an exact inventory `item`, a required registered
`release` (for example `adguard-home`), and fixed `inspect`,
`install`, `health` argument arrays. Executables must be absolute. The install argv
must contain `{version}`, replaced by the exact approved stable version. No shell,
browser-supplied command or remote script URL is accepted. Recipes must be reviewed
for the actual installation method; a version collector is not an installer recipe.

SSH uses explicit user/port/key/trust files, strict host-key verification, no agent,
no inherited SSH configuration and no forwarding. Bun owns coordination; the remote
side uses the host's existing `/usr/bin/python3`. A fixed transient program is sent
for this invocation only; no daemon, helper installation, cron entry, lock file or
backup directory is left on the host. APT additionally requires existing `python3-apt`.

**Privilege boundary:** these are operator-owned recipes, not a restricted SSH shell.
Docker control and `sudo /usr/bin/python3` are effectively host-administrator access.
Application allowlists are not a sandbox if the worker or its key is compromised.
Provisioning that access requires a separate explicit approval and deployment review.
Do not reuse read-only reporting credentials or mount keys into the dashboard web
process. Auth has no dependency on update access. The dashboard runtime image includes
OpenSSH for the worker; the auth image does not.

## Adapter guarantees and limits

### Docker Compose

The worker independently resolves a fixed public registry candidate. Classic Docker
config IDs, containerd image-index IDs and platform-manifest IDs are normalized to the
selected platform's content before comparing them. Metadata or other-platform changes
alone are not software updates. Unresolvable installed identities become unknown.
Blob reads follow at most four redirects to exact Docker/GitHub CDN origins. Registry
bearer tokens are never forwarded to storage origins. Manifest and token redirects
remain disabled; unavailable optional version labels cannot fabricate availability.
The raw local store identity remains the execution fence and post-pull verification
uses that store's identity representation: config, image index and platform manifest
remain distinct, including when a manifest was reached through a multi-platform index. The host verifies
the exact container, installed image identity, repository and Compose project/service.
It pulls the approved immutable digest, verifies the platform image ID, then changes
one unambiguous literal `image:` line in the configured source. Symlinked sources,
interpolated/ambiguous image declarations and concurrent source edits fail closed.
Resolved Compose configuration must differ only in that one service's image.

Only that service is recreated with `--no-deps --no-build --pull never`. A stopped
container stays stopped; a running service is awaited as running/healthy using
[Compose's lifecycle options](https://docs.docker.com/reference/cli/docker/compose/up/).
Volumes are retained. Automatic execution rechecks actual installed/pulled versions;
opaque channels require comparable image-version metadata or manual approval.

The new pin is persisted in the configured Compose file. It is **not** committed or
pushed to Git automatically. A configuration-management deployment must consume that
updated source, not overwrite it with an old pin. Installation failures are not blindly
rolled back: an application may already have migrated its persistent data. Inspect the
failed run and service before deciding recovery; PBS remains the backup system.

Projects with runtime secret delivery may configure the Docker driver's optional
`environment` with a deployment-owned `command` argument array and an explicit
`variables` name allowlist. The absolute command runs once on the target, under
the target's execution identity, and must return a JSON object. It may call the
project's existing secret-delivery entry point; Homelab does not install a helper
or depend on a particular secret manager. Its recipe is part of the target
fingerprint, so changing it invalidates automatic policy consent.

Only the named string values are passed to the Compose subprocesses, not image
pull/inspect commands. Values stay in target process memory: no `.env` file,
worker response, log or database copy is created. JSON is bounded to 64 KiB, each
value to 16 KiB, with a 30-second delivery deadline. Missing or malformed values
fail before pulling an image or editing Compose. Process/CLI control variables
such as `PATH`, `DOCKER_HOST`, `COMPOSE_FILE` and `LD_PRELOAD` cannot be selected.
When this source is configured, implicit `.env` loading is disabled; supply all
required interpolation inputs through the explicit source. Without this option,
the existing Compose environment behavior is unchanged.

### APT

Installed and repository candidate versions are checked again on the target. APT
resolves dependencies; removals, downgrades and changes to held packages are refused.
Automatic plans additionally reject new/unknown/major dependency changes. Exact
planned versions are passed to APT, existing conffiles are retained and no autoremove,
distribution upgrade or reboot is performed. A reboot-required flag produces a
notification, not a host restart. Package scripts may restart their own services.
The repository metadata refresh remains the host's existing APT responsibility.

### Native software

Fixed inspect/install/health commands must verify the exact version before and after
the update. No generic tarball extraction or arbitrary installation-script execution
is inferred from discovery. Qualify separate recipes for different installers, service
owners and health checks. Appliance firmware, HAOS and application extensions require
their own supported adapter; they must not be presented as managed merely because a
version is visible.

Three built-in recipes are also available. Replace the command recipe's `inspect`
and `install` fields with `recipe`; keep `kind: "native"`, the exact inventory `item`,
matching `release` and a deployment-owned `health` command. These use the same manual,
bulk and opt-in automatic queues, permissions, version fences and receipts.

```json
{
    "kind": "native",
    "item": "application:adguard-home",
    "release": "adguard-home",
    "recipe": {
        "application": "adguard-home",
        "binary": "/opt/AdGuardHome/AdGuardHome",
        "service": "AdGuardHome.service"
    },
    "health": [
        "/usr/bin/curl",
        "--fail",
        "--silent",
        "--max-time",
        "10",
        "http://127.0.0.1:3000/"
    ]
}
```

- **AdGuard Home:** downloads the exact official amd64/arm64 archive and its SHA-256
  checksum. It extracts no archive paths, stages and checks one binary, then replaces
  only the existing executable with ownership/mode preserved. Special mode bits and
  extended attributes (including capabilities, ACLs and security labels) are rejected
  before replacement, including metadata changes during preparation. Such installations
  need a separately qualified recipe; required metadata is never silently discarded. Configuration and data
  stay untouched. Temporary staging is removed even on failure. Only a previously
  running service is restarted; an inactive service remains inactive.
- **OpenClaw:** `recipe` contains `application: "openclaw"`, a fixed `command` argv
  prefix and the existing systemd `service`. The prefix must enter the actual owning
  account and its runtime/environment (for example the existing `runuser`/`env` entry
  point); do not run an unrelated root/global installation. The official updater gets
  `update --tag <approved-version> --yes --no-restart`. It does not change channels or
  accept new plugin capabilities. Homelab verifies the exact version and restarts only
  a previously active service, then invokes the configured health check.
- **Nextcloud:** `recipe` contains `application: "nextcloud"`, installation `directory`,
  absolute `php` executable and service `user`.
  The release checker prefers the installed major's latest stable point release before
  proposing the next major; its cache is specific to the installed version. Missing
  release series in the bounded official catalog are unknown, never a guessed jump.
  Before mutation it checks that the installed updater's help advertises `--url`,
  `--signature`, `--no-backup` and `--no-interaction`, as well as status, core
  integrity and absence of unfinished updater state. The official stable update feed
  must offer the exact approved version for this installation/PHP combination, with
  its signature and canonical release archive. It invokes the installed updater with
  that pinned URL/signature, never `--no-verify` or `--ignore-state`. Unsupported
  candidate hops, legacy updaters without these options and modified core files fail before installation. Nextcloud's own
  updater preserves non-shipped apps/configuration and performs its database upgrade;
  Homelab verifies both resulting version and completed maintenance/database state.
  The invocation uses `--no-backup`: a current, tested PBS backup is a prerequisite to
  activation, not a second unmanaged local backup. No automatic rollback of migrated
  application data is attempted. Vendor updater logs/recovery state are not deleted.

For stopped services, successful installation means the on-disk version was verified;
online health is checked only for running services. A failed restart or health check
is a failed job, never a successful receipt. Third-party updater recovery state may
remain after a failed operation and requires operator inspection.

Vendor references: [AdGuard Home updates](https://github.com/AdguardTeam/AdGuardHome/wiki/Getting-Started#update),
[OpenClaw update CLI](https://docs.openclaw.ai/cli/update), and
[Nextcloud signed updater](https://docs.nextcloud.com/server/latest/admin_manual/maintenance/update.html).

## Acceptance before activation

Use the disposable preview for UI acceptance first. It has isolated Docker, OS and
native examples, ordinary job progress, a successful installer and a deliberate health
failure. Its executor neither opens SSH nor invokes a package manager. Preview settings
affect only synthetic data. Stopping the preview removes its temporary database.

Production qualification is separate: inventory every enabled source, verify retained
Loki aliases, review each update recipe, check strict SSH trust and actual Compose
layout, test an explicitly approved low-risk target and verify its health/receipt. Keep
automatic policies off until that succeeds and the operator opts in per target. This
branch does not provision keys, activate production update policies or update hosts.
