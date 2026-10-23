# Maintenance operations

The existing Bun worker owns job execution. With concurrency 3, one existing slot
is reserved for light/network control jobs and two slots accept general work.
Scheduled and human-started checks have identical access to the reservation.
Only light/network jobs with a deadline of at most sixty seconds qualify. Broad
release scans and update preparation with longer budgets use the general slots,
so a slow inventory lookup cannot occupy the reserved lane for several minutes.
Installation and restart jobs keep their physical-host leases. The reservation does
not bypass a pause, a shared resource lock, or deliberately exclusive work.

Run details distinguish elapsed time, last progress and worker responsiveness.
Quiet package managers are not classified as stuck. Update jobs retain bounded,
verified per-item receipts even if a later item fails. Missing health probes remain
explicitly unchecked; existing stopped services remain stopped. Native application
advisories are not cleared by these receipts.

## Explicit restart authority

`HOMELAB_DASHBOARD_MAINTENANCE_TARGETS` is deployment-owned JSON, supplied identically
to dashboard and worker. It defaults to `[]`; existing update consent never grants
restart authority. Each target refers to an existing update connection by ID. No SSH
key, new login, shell command from the browser, daemon, persistent helper or network
route is provisioned by this feature.

The existing `deploy/compose.worker.yaml` overlay forwards both maintenance and
release-reporting settings to dashboard and worker. Supply the nonsecret recipe
through the normal deployment environment; do not mount the worker's credentials
into the web app.

```json
[
    {
        "id": "example-web",
        "connection": "example-host-updates",
        "label": "Example web service",
        "impact": "Example web will be unavailable briefly; other applications remain available.",
        "kind": "service",
        "service": "example-web.service",
        "health": [
            "/usr/bin/curl",
            "--fail",
            "--silent",
            "--max-time",
            "5",
            "http://127.0.0.1:8080/health/ready"
        ],
        "workerIndependent": true
    }
]
```

A host restart uses `"kind": "host"` and omits `service`; its health command runs
after reconnection. It must explicitly describe all affected services in `impact`.
`workerIndependent: true` is a deployment attestation, not automatic dependency
detection. Review the worker host, database, hypervisor, SSH/DNS/secret-delivery and
other dependencies before granting this flag. Do not enable restarts that can stop
the observing worker or its database. Those require the existing external operator
procedure; this release does not add self-deployment or a second control plane.

Read-only checks observe the OS reboot flag, selected service state and, when
available, the distribution's `needrestart -b -r l` service list. Missing inspection
remains unknown. Plans expire after two minutes; an accepted queue request has a
five-minute admission budget. Before mutation, the worker rechecks configuration,
boot identity, service state and the systemd invocation ID. Each service activation
has a different invocation ID, so an earlier confirmed plan cannot restart the
same service again after another queued or external restart. The remote command
checks the identity again immediately before mutation. Missing invocation evidence
requires a fresh inspection; a stopped service is never implicitly started.
The database clock controls admission age, including a second check after inspection,
and timestamps restart observations consistently across update and restart workers.
Status probes share the host lock with restarts and updates. A source spanning more
than one host retains an unknown source-level restart requirement; each receipt
still reports the individually verified host.

Only a human with `maintenance:restart`, `jobs:run` and recent MFA may confirm.
Automation tokens are refused even if assigned that capability. Each restart has
one attempt, an audit history and ordinary job notifications. A host request may
disconnect SSH; the worker only polls afterward and never resends the reboot.
Success requires a new boot identity and the configured health check. Cancelling
after the OS accepts a reboot cannot undo that reboot. Failure, cancellation or
worker loss can leave an unknown external outcome requiring inspection.

## Homelab release overview

Set `HOMELAB_DASHBOARD_RELEASE_REPOSITORY=owner/repository` identically on both
dashboard and worker to enable the read-only `homelab.release` job. The existing
optional GitHub read credential is used only on `api.github.com`. Asset redirects
are limited to official release storage and never carry that credential.

The published manifest must contain both immutable Auth and dashboard images for
the exact version and tag commit. The matching release-triggered Container images
workflow must have completed successfully before publication is labelled verified.
The exact manifest bytes must also match the SHA-256 digest of the unarchived
`release-manifest-<attempt>.json` Actions artifact from that successful workflow run
and attempt. A changed release asset cannot reuse evidence for different image
digests. The release workflow retains this evidence for ninety days; older releases,
expired evidence and builds without this artifact remain explicitly unverified.
For a private repository, the optional credential also needs Actions read access.
Failed refreshes and observations older than twenty minutes are shown as stale.
The panel separately reports the serving dashboard version, live worker versions
and Auth versions from authorized inventory publishers. The UI uses concise
verification and stale-status badges without collection timestamps or build internals.
An available or verified release is not evidence of deployment.

Schedules for removed targets retain their saved policy but are excluded before
scheduler and UI pagination. They cannot block currently configured jobs, and a
temporarily removed target can recover its existing schedule when reintroduced.

## Release qualification and rollout

1. Run the repository's Bun checks, unit/component tests, isolated PostgreSQL
   integration tests, both builds, built smoke tests and Docker lifecycle smoke.
2. Review the additive dashboard migration: `job_runs.results` retains bounded safe
   receipts, and `workers.reserved_capacity` reports actual registered reservations.
   Existing rows receive empty results/zero reservation; no identity schema changes.
3. Build and publish through the normal reviewed release workflow. Record the
   previous image digests and a verified dashboard database backup.
4. Pause admission, let active work finish, stop dashboard and worker, explicitly
   apply the released dashboard migration, and start both from the same tested
   digest. Auth needs no migration or restart for these dashboard features.
5. Verify readiness, one reserved slot at concurrency 3, and a human-started check
   alongside two busy general slots using the disposable test deployment. Resume
   the previous worker pause state after production readiness checks.
6. Review and enable specific restart recipes separately. Qualify a noncritical
   service restart and a worker-independent host restart in an agreed maintenance
   window, confirming retained data, new boot identity and actual application health.

Do not silently downgrade the binaries after migration: startup checks require an
exact migration inventory. Prefer a forward repair release. A full rollback needs
the matching prior database backup and image pair under a separate recovery plan;
restoring it can discard newer operational history. Keep the normal external deploy
procedure for Auth/dashboard/worker and their infrastructure dependencies.
