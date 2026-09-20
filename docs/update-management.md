# Update management

Reporting does not grant installation access. `updates.releases` remains read-only.
The worker registers installers only for explicit `HOMELAB_DASHBOARD_UPDATE_TARGETS`.
All automatic policies default to **off**, including Docker and digest-pinned images.

## Authority and lifecycle

- `updates:read` reads inventory and policies. `updates:publish` can publish only the
  account's configured source; it cannot enable a policy or authorize an install.
- `updates:apply` plus `jobs:run` queues a confirmed candidate. Human requests also
  require recent step-up verification. Automation accounts require explicit scopes.
- `updates:configure` changes automatic policy and requires a recently verified human.
- Every request binds the source observation, versions, target and recipe to a digest.
  The worker rechecks it immediately before execution. Queued authority expires after
  five minutes; expired work must be confirmed again. Changing a target invalidates its
  previous automatic consent. Disabling a policy stops queued automatic work, not an
  installation already executing on the host.
- Automatic admission accepts comparable stable patch/minor versions only. Majors,
  prereleases, downgrades, held packages, stale reports and unknown version schemes
  never become automatic installs. A Docker tag/digest pin is not a package hold.
- Installers use the existing queue, resource leases, audit trail, progress events,
  notifications and worker-activity UI. An installer has **one attempt**, not retries.
  A failed/expired automatic candidate is not silently requeued while its run remains
  in retained history. Hosts are never rebooted automatically.

## Deployment-owned targets

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
A native target uses `kind: "native"`, an exact inventory `item`, and fixed `inspect`,
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

The worker independently resolves a fixed public registry candidate. The host verifies
the exact container, installed config digest, repository and Compose project/service.
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
