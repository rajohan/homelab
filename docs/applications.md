# Application operations

## Legacy log labels

Container selectors remain exact by default. When retained logs predate container
labels, deployment configuration can add `logs.legacy` with a fixed past `until`
timestamp, a `serviceLabel` and explicit `services` entries containing `project`,
`service` and the old label `value`. Each alias must map to exactly one approved
project/service, and its provenance must be verified by the operator. No current
inventory heuristic guesses ownership of historical names. The old query requires
an absent/empty container label, preserves the fixed host selectors, and ends at
the cutoff. It cannot include newer unlabeled logs or another current container.
Both streams share the same bounded cursor and timestamp collision handling.

Applications manages **existing** Docker containers and Compose-labelled projects. Start, stop
and restart never pull images, rebuild, recreate, prune, delete data or execute arbitrary commands.
Project operations use Docker's API with Compose dependency labels; this is not a replacement
for `docker compose up`. Missing/unsupported dependencies and cycles fail before writes.
Readiness conditions are respected when starting dependents: `service_healthy` requires a running,
healthy container, while `service_completed_successfully` waits for exit code zero independently
of transient health-check failures. Final checks likewise require declared one-shot dependencies
to complete. Failures can leave a project partly changed. Such operations are never automatically retried.

## Boundaries

- Browser: safe metadata and explicit intents only. No endpoint, shell command, credentials or LogQL.
- Dashboard web: live capability checks, recent human MFA, stable revision and idempotent queue admission.
- Worker: exact allowlisted target, identity/revision revalidation, bounded queue age (two minutes),
  job cancellation/deadline, dependency ordering and bounded Docker API calls.
- Auth: no Docker or host-administration access.

Start/stop/restart require `jobs:run` plus their respective `applications:start`,
`applications:stop` or `applications:restart` capability. Reading requires `applications:read`;
logs require `applications:logs`. Machine tokens must explicitly receive these capabilities.
The generic jobs endpoint cannot bypass application confirmation. Accepted jobs expire before
execution after two minutes, measured against the database clock; cancelling/revoking credentials does not roll back already accepted
external effects. Docker offers no transactional rollback or exactly-once operations; ambiguous
failures must be inspected before a new request is made.

Inventory is refreshed every 60 seconds and after successful actions. The UI reads it every five
seconds while foregrounded. Snapshots older than two minutes and unavailable hosts disable control.
Snapshot persistence and freshness checks use the database clock, including rejection of future
timestamps from older writers. The web API exposes that freshness decision to the browser;
worker, web-server and browser clock differences cannot extend the control window.
The API re-filters snapshots against current configuration, preventing removed projects from
remaining readable. Environment variables and arbitrary labels never reach the browser.
Hosts are discovered concurrently with separate 20-second budgets and at most four concurrent
inspections per host. One unavailable host retains its previous identities without preventing
fresh snapshots for reachable hosts. Whole-job cancellation still aborts collection. Confirmation
revisions include health status, so health-only changes also invalidate stale lifecycle intents.
Project actions list only the selected allowlisted project, without inspecting unrelated projects.
Each container is revalidated again immediately before its first mutation, after any dependency
waits or earlier operations. The project's exact membership is re-listed before every mutation,
including the start phase of a restart, and before reporting completion. Added, removed or replaced
members fail closed; listing order does not matter. Docker has no conditional compare-and-mutate
API, so this narrows the race window but cannot make external mutations atomic.
After all readiness waits, every selected container is inspected again with at most four concurrent
requests before success is reported. A service that regressed while a later service initialized
fails this final check; declared one-shot dependencies must still have exited successfully.
These are fresh observations, not an atomic snapshot or a guarantee of future availability.

Container actions include transitive same-project network, PID and IPC namespace
consumers. The confirmation names these related services and its revision covers the
whole group. Stop proceeds consumer-first; start proceeds provider-first and waits
for readiness. Restart keeps previously stopped consumers stopped. Missing immutable
provider IDs are rejected before stopping a running consumer: lifecycle actions do
not silently recreate containers or repair their configuration. Cross-project
namespace groups fail closed.

Application host IDs must match the corresponding update reporting source IDs.
Configuration binds the Docker endpoint and that source's SSH host addresses to the
same job resource leases, even when Docker uses a bridge IP and SSH uses a LAN IP.
Lifecycle admission acquires all these keys; execution checks that the saved job
still holds the current keys. Unrelated hosts can execute concurrently.

Discovery accepts at most 20 hosts and 200 containers per host. Each inspect response is
limited to 512 KiB, with at most 32 networks, 128 exposed ports, eight bindings per port and
64 mounts. Selected browser metadata is limited to 32 KiB per container, 1 MiB per host and
8 MiB per complete snapshot. A host exceeding these limits is marked unavailable as a whole,
never exposed as a partially actionable project. Retained snapshots follow the same limits;
oversized retained metadata is discarded. The database read also rejects oversized legacy snapshots.

## Opt-in production configuration

`HOMELAB_DASHBOARD_APPLICATION_TARGETS` is JSON containing host IDs, labels, exact HTTPS origins,
explicit project allowlists and **secret names**, not secret values. Example:

```json
[
    {
        "id": "apps",
        "label": "Application host",
        "endpoint": "https://docker.example.internal:2376",
        "projects": ["media"],
        "tls": {
            "ca": "HOMELAB_DASHBOARD_DOCKER_APPS_CA",
            "certificate": "HOMELAB_DASHBOARD_DOCKER_APPS_CERT",
            "key": "HOMELAB_DASHBOARD_DOCKER_APPS_KEY"
        },
        "logs": {
            "labels": { "host": "apps" },
            "serviceLabel": "service",
            "servicePrefix": ""
        }
    }
]
```

Give the configuration to both web and worker, but give the referenced TLS credentials **only
to the worker** through its scoped secret delivery. HTTPS hostname verification stays enabled;
redirects are forbidden. HTTP is accepted only for explicit loopback development/test fixtures.
The Docker API version is v1.47; validate host compatibility before enabling it.

**Docker client certificates normally grant daemon-wide, root-equivalent authority.** Application
allowlists restrict this software's behavior, not a stolen certificate. Production provisioning
therefore needs explicit approval, host/network restriction and suitable daemon-side authorization
where available. This branch provisions no listeners, certificates or access grants. Do not include
the dashboard/worker, identity, database or other control-plane projects in an ordinary application
allowlist: stopping them would interrupt the control path and its audit delivery.

## Logs

`HOMELAB_DASHBOARD_LOGS_URL` selects the existing read-only Loki endpoint. An optional
`HOMELAB_DASHBOARD_LOGS_TOKEN` supplies bearer authentication. The web process needs this read
access; it does not need Docker keys. Loki itself does not enforce authorization, so restrict its
listener/proxy accordingly. Only expose a reviewed, redacted stream: the dashboard escapes log
text but cannot reliably remove secrets from arbitrary raw application output.

Each host supplies exact fixed labels plus a label mapped to the **Docker container name**
by default. Set `serviceValue: "service"` to select the Compose service name instead,
for example `serviceLabel: "service"` and `servicePrefix: "app-"`. This includes
retained service history from older container instances and service replicas.
Service-name selectors covering multiple configured projects require `projectLabel`,
even when only one matching service is currently running: retained streams outlive
containers. A single-project scope without that label requires deployment verification
that its fixed labels and service prefix cannot match another project's retained streams.
Never infer historical uniqueness from the live inventory. Verify the actual ingestion
labels before changing configuration. Host selection stays exact and server-owned.
Searches are escaped literal text, with a maximum seven-day range (one day by default),
two-megabyte response budget and timestamp-safe cursor pages. Large timestamp
groups fail explicitly rather than silently dropping records. Retention remains Loki's policy.
Loki log ranges include `start` and exclude `end`. A complete same-timestamp group is read with
`[timestamp, timestamp + 1 ns)`; the next page ends at that timestamp so it cannot repeat the group.

Live updates poll every five seconds. Loading older history pauses live updates to preserve the
reading position; enabling live updates returns to the newest page. Only an open log view queries
Loki. Browser HTTP responses remain private and non-cacheable through the existing API boundary.
An empty range is not itself an ingestion failure: quiet applications may have no
retained events. Widen the range to distinguish this from a wrong selector, failed
collector or a logging driver whose output is not being shipped. Keep existing
redaction and retention; do not bypass them by exposing raw Docker output.

The disposable preview uses repository-owned loopback fixture APIs and synthetic metadata/logs.
The `demo` project contains a database and dependent web container. Actions take two seconds,
followed by four seconds of simulated health checks, making stop/start/dependency progress
observable in the real worker's run inspector. `failure-demo` contains `demo-health-failure`:
starting it intentionally fails its simulated health check so failure events and notifications
can be tested too. Stop it to return it to its initial stopped state. These delays and the
failure project are opt-in fixture settings, not production behavior or slower test defaults.
The synthetic `developer` account has a preview-only authenticator enrolled so the normal
MFA policy stays enforced. Use password `Development-only-password-123!` and obtain its
current six-digit code with `bun --no-env-file scripts/devIdentity.ts --code`. This command
only computes the public fixture code; it does not start, reset or connect to a database.
Alternatively add the public fixture key `JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP` to a test
authenticator. Never use these public credentials for real accounts. Codes are single-use,
so wait for the next 30-second code if another fresh proof is needed immediately.
It never controls the real Docker daemon. Stop the preview normally to remove its PostgreSQL
container and close both fixture servers and applications.

## Job activity

Accepted actions close the confirmation dialog without opening run details automatically.
A worker icon beside the notification bell opens a shared activity panel, showing the
signed-in operator's queued/running jobs and up to
five recent completions from the last 15 minutes. It works across routes and recovers from the
server after a browser refresh; scheduled jobs and other operators' jobs do not appear there.
Active jobs poll every second while the page is visible, with a five-second idle discovery poll.
The icon animates while a reported job is running, honoring reduced-motion preferences. The
panel opens when this browser successfully submits a manual job, but never from background
polling or scheduled work. Closing it never cancels work or stops status polling.
Each entry opens the existing run inspector and shows the latest worker-reported progress.
Completed entries can be dismissed for the current dashboard session without deleting history.
The panel is not application-specific: manually requested jobs of any registered type appear.
Recent completions are selected by database completion time before applying the five-run limit,
so an older-created long-running job still appears when it finishes.

Application run titles snapshot the confirmed container/project name, for example `Restart web`.
Replays keep the original title even after inventory changes. Terminal failure explanations are
recorded in Run events instead of repeated in a separate status box above the event list.
For retained runs created before event messages existed, only the final matching outcome event
inherits the saved run explanation; earlier attempts and explicitly recorded messages are unchanged.
