# Dashboard operations

The dashboard web server and Bun worker are independent processes sharing a dedicated
PostgreSQL database. Auth keeps its own database and remains independent of both.
No Docker socket, root SSH access, arbitrary shell command or client-provided URL is
exposed by this foundation.

## Job progress

Every handler receives `context.reportProgress(message)`. Await it before meaningful
steps and readiness waits, using short, code-owned text rather than raw errors, secrets,
commands or provider responses. This is shared by maintenance, telemetry and application
jobs; no Docker-specific progress protocol is required. Handlers remain responsible for
describing their own work, so new job types must add their appropriate messages.

Progress updates are fenced by the current live, uncancelled claim. The latest message
is stored on the run; consecutive duplicates are ignored and event history is capped at
1,000 messages per run. Existing history retention applies. Final status and notifications
are still produced by the worker's atomic settlement, not by a handler claiming success.
An open active run refreshes every second in the foreground and stops polling at a
terminal state. Closing the dialog does not cancel the job. Cancel through Jobs explicitly.
Security confirmation is shared by the entire dashboard, including actions outside Settings.

## Configuration and rollout

Use a dedicated dashboard database/role. Do not point these settings at the Auth database.
Store credentials in the existing scoped Doppler delivery, not in a committed `.env`.

| Setting                                | Purpose                                                         | Default      |
| -------------------------------------- | --------------------------------------------------------------- | ------------ |
| `HOMELAB_DASHBOARD_DATABASE_URL`       | Dashboard PostgreSQL connection with verified TLS in production | Unconfigured |
| `HOMELAB_DASHBOARD_METRICS_URL`        | Prometheus-compatible API base URL, including any tenant prefix | Disabled     |
| `HOMELAB_DASHBOARD_METRICS_TOKEN`      | Optional read-only bearer credential for dashboard and worker   | None         |
| `HOMELAB_DASHBOARD_WORKER_CONCURRENCY` | Concurrent job handlers per worker, 1–16                        | 3            |
| `HOMELAB_DASHBOARD_JOB_RETENTION_DAYS` | Completed jobs and operational audit retention, 1–365 days      | 30           |
| `HOMELAB_DASHBOARD_WORKER_HOST`        | Private health/metrics bind address                             | `127.0.0.1`  |
| `HOMELAB_DASHBOARD_WORKER_PORT`        | Private health/metrics port                                     | 3112         |

1. Provision the dedicated role/database and scoped configuration separately.
2. Stop old dashboard workers before a schema-changing deployment.
3. Apply the shipped schema explicitly: `bun run dashboard:migrate --apply`, or
   `bun --no-env-file migrate.js --apply` from the built dashboard artifact.
4. Start dashboard and worker from the **same pinned dashboard image digest**.
   `deploy/compose.worker.yaml` is the optional overlay for the existing deployment.
5. Verify both `/health/ready` endpoints, then check Jobs for worker heartbeat and runs.

Neither process applies migrations automatically. Worker startup and web readiness fail
closed on a schema mismatch. No production service is enabled by checking out this code.
The existing release publishes the dashboard image; `worker.js` and `migrate.js` are
included in that artifact, so there is no independent worker image/version stream.

## Queue behavior

Only code-registered, validated job types can execute. Queue admission, claims, schedules
and audit transitions are transactional. Short PostgreSQL transaction locks work through
PgBouncer transaction pooling; no session locks or LISTEN connection are required.

- Each run owns resource keys and a fenced 30-second lease renewed every five seconds.
- Different resources can execute concurrently; overlapping resource keys cannot.
- Work size is a code-owned resource class, captured on each run. `exclusive` runs
  alone across the queue; at most one `host-heavy` run executes at a time. `light`,
  `network` and `interactive` jobs share normal worker capacity and resource fences.
- Only explicitly retry-safe work retries automatically. Unknown outcomes for unsafe
  effects require operator investigation; the engine does not promise exactly-once effects.
- Database result commits recheck ownership. External integrations honor cancellation and
  document their downstream guarantees. Docker cannot roll back or guarantee exactly-once writes;
  its lifecycle jobs reject stale selections and never automatically replay unsafe effects.
- Cancellation is cooperative. Handlers must honor the supplied signal and timeout.
- Missed schedule intervals coalesce, and active runs prevent overlapping scheduled copies.
- User request IDs deduplicate while the run is retained, not forever after cleanup.
- Completed history is removed in bounded hourly batches. Active work is never pruned.
- An orderly worker shutdown retires its registration after claims settle. Bounded
  maintenance also removes stopped registrations and registrations silent for a day,
  but never while a running claim still references them. A process whose registration
  expired exits rather than silently accepting more work. Job history is independent.

Monitoring incidents, backup protection and software observations are documented in
[Monitoring operations](monitoring-operations.md). They use separate registered jobs,
permissions and source-freshness states.

- Each worker process has a unique registration, not a permanent host identity. Orderly shutdown removes its registration after all claims settle. Hourly maintenance removes older stopped registrations and unresponsive registrations after 24 hours, only when they own no running jobs. Job and audit history remains independent of these temporary registrations.

## Scheduling and worker control

Jobs supports **daily**, **interval** and **five-field cron** schedules. Daily and cron
use the system clock, including daylight-saving changes; there is no per-job time-zone
setting. Run the dashboard and every worker with the same system time zone. The optional
Compose overlay mounts the host's `/etc/localtime` read-only into both processes.
Intervals retain their anchor when missed rather than drifting with scheduler ticks.

Each job has a description, work size, manual **Run now**, schedule editor and its own
paginated history. The main view shows all queue states (including zero counts), actual
queued/running jobs, recent completed runs and worker heartbeat/capacity/version.
Run details show execution policy, attempts and a bounded event history without payloads.

Disabling a schedule requires a reason. It can be indefinite or resume automatically at
a chosen time. Disable intent survives cadence edits, is audited, and is not a job error.
Disabling does not cancel work already queued/running, and manual runs remain available.
Use a job's Cancel action for cooperative cancellation instead.

**Pause worker** is a durable queue-wide pause, not a process kill. It stops automatic
submissions and new claims; current jobs finish normally. Manual requests can queue while
paused. Heartbeats and health checks continue; resuming combines missed occurrences into
at most one run per job. Version checks prevent stale controls from overwriting changes.

New integrations implement `JobHandler` and register through `createOperationsRuntime`.
They own their validation, resources and execution policy instead of adding special cases
to the queue. The first integration reads fixed metric aggregates; absence/staleness is
shown explicitly and is not reported as healthy infrastructure. No provider credentials
or full metric labels are returned to browsers.

## Automation access

Settings manages named accounts with explicit capabilities. Administration requires a
live human session and recent MFA through Auth; machine tokens cannot administer access.
Dashboard users are governed by the Auth client's group policy. Account and credential
changes use version checks so stale browser state cannot silently overwrite new grants.

Tokens are shown once and stored as SHA-256 digests, never recoverable plaintext. Each
request checks live grants, account state, token revocation and expiry. Rotation stages a
replacement; revoke the predecessor only after updating the client. Up to five live tokens
per account are supported. The UI shows every live token plus recent retired metadata,
bounded to ten credentials per account. Tokens default to 90 days in the UI; no expiry is
an explicit option. Auth cookies and browser origins are rejected on the machine endpoint.

Use the same typed tRPC router at `/api/automation` with `Authorization: Bearer <token>`
and no cookies or Origin header. Transport is tRPC/SuperJSON, not an OIDC token endpoint.
For example, `GET /api/automation/jobs.list?input={"json":{}}` (URL-encode the input)
requires `jobs:read`. Runs use `POST /api/automation/jobs.run` with
`{"json":{"action":"infrastructure.metrics","requestId":"<fresh UUID>"}}` and
`Content-Type: application/json`, requiring both `jobs:run` and `infrastructure:refresh`. Reuse the request UUID only
when retrying the same intended request. Each account is limited to 120 requests/minute.
Never put bearer tokens in URLs or logs.

Supported permissions are defined once in `packages/contracts/src/permissions.ts` and
drive both validation and the grouped Settings picker. They are enforced independently:

| Permission               | Authority                                                 |
| ------------------------ | --------------------------------------------------------- |
| `jobs:read`              | Run lists and run details                                 |
| `jobs:run`               | Submit a job, also requiring that job's action permission |
| `jobs:cancel`            | Cancel queued/running work                                |
| `schedules:read`         | Schedule inventory and next-occurrence preview            |
| `schedules:write`        | Edit cadence, disable with a reason, or enable schedules  |
| `worker:read`            | Worker inventory, queue counts and pause state            |
| `worker:control`         | Pause/resume queue execution                              |
| `infrastructure:read`    | Read saved infrastructure summaries                       |
| `infrastructure:refresh` | Execute the infrastructure metrics job with `jobs:run`    |
| `operations:maintain`    | Execute history cleanup with `jobs:run`                   |

Choosing one permission does not silently grant the others. Future integrations must
register and enforce their permissions together. [Application controls](applications.md) add
separate read/log/start/stop/restart permissions; [notifications](notifications.md) add read and
publish permissions. No arbitrary terminal or filesystem authority is exposed.
Machine tokens cannot manage other accounts.

## Monitoring and development

Scrape the worker's private `/metrics` with VictoriaMetrics/Prometheus. Suggested checks:
`homelab_worker_ready == 0`, stale/missing scrape, sustained failed-job increase, and
dashboard `/health/ready` failure. Logs contain run ID, action and classified outcome,
not payloads or raw upstream errors. Keep the worker endpoint off the public proxy.

`homelab_worker_paused` distinguishes intentional pauses from failures without suppressing
real process/database faults. `homelab_schedule_enabled{action}` reports schedule intent;
`homelab_schedule_overdue{action}` is zero for disabled schedules and while the worker is
paused. Use these intent gauges to gate schedule-freshness alerts; do not alert merely
because the last successful run grows old while a schedule is deliberately disabled.

`bun run dev:identity` starts disposable Auth and Dashboard databases plus the worker on
loopback, with synthetic Docker/Loki fixtures. It has no production control credentials.
`HOMELAB_PREVIEW_METRICS_URL` may explicitly enable read-only telemetry during development;
identity, jobs, notifications and application lifecycle state remain entirely synthetic.
Stop with Ctrl+C to remove that exact container and all preview data. The ordinary
integration suite also allocates a separate disposable database per test suite.
