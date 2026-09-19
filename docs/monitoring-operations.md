# Monitoring, backups and update observations

Overview reuses the same inventory, queue and domain query caches as the detailed
pages. It does not add guest allocations to physical host totals. Alerts, Backups
and Updates are separate read-only integrations; neither Auth nor application
lifecycle access depends on them.

## Incidents

Set `HOMELAB_DASHBOARD_ALERTMANAGER_URL` to a trusted, private Alertmanager API
base. Optional `HOMELAB_DASHBOARD_ALERTMANAGER_TOKEN` supplies a read credential.
`HOMELAB_DASHBOARD_ALERT_EXCLUDED_NAMES` defaults to `["Watchdog"]`.
Give these settings to both web and worker, with network access only from the worker.
If using a proxy, expose only GET `/api/v2/alerts`; this integration never creates
silences, changes routes or acknowledges upstream incidents.

The independent `monitoring.alerts` job polls every minute. Active and suppressed
alerts are included. A fingerprint plus its start time identifies an episode.
New episodes and observed resolution create deduplicated notifications, atomically
with incident state under the worker's live claim. Read/dismiss receipts affect
only that person's notification inbox, never the incident.
Resolved history sorts by resolution time, with the incident ID breaking ties.
Cursor timestamps preserve PostgreSQL microseconds, including across retention deletions.

A failed, oversized, malformed or cancelled poll does not resolve anything or
advance freshness. Three minutes without a successful observation is stale.
History starts when collection is enabled: alerts that begin and end between
polls cannot be reconstructed. Dashboard history is not a replacement for the
monitoring system's event history. Pausing the worker also pauses observation.
Only allowlisted resource labels are retained; arbitrary annotations, URLs and
raw payloads are discarded. Resolved history follows job retention.

## Backups

The `backups.status` job reuses the existing read-only VictoriaMetrics endpoint
once per minute. It reads `homelab_backup_*` and node-exporter reachability,
including PBS guest jobs, host/config jobs, verification and PostgreSQL logical
backups when the corresponding collectors publish them.

Success comes from the task's completion result and maximum allowed age, not a
recent scrape. Disabled, running, failed, overdue and unknown remain distinct.
Missing exporter data never carries forward old healthy measurements. Backup
identity can survive an exporter outage, but source freshness is shown separately.
This page does not list backup contents, download archives, restore data or grant
PBS administration. It depends on the existing collector/timer health monitoring.

## Software inventory

Each source has its own automation account with only `updates:publish`. Configure
the same source registry in web and worker:

```json
[
    {
        "id": "example-host",
        "label": "Example host",
        "publisher": "11111111-1111-4111-8111-111111111111"
    }
]
```

The value goes in `HOMELAB_DASHBOARD_UPDATE_SOURCES`. IDs and publisher accounts
must be unique. The authenticated publisher determines the source; the submitted
body cannot select another host. Human sessions cannot publish reports.

Reports use POST `/api/automation/updates.publish`, with a 950,000-byte body limit
matching the native publisher, including the transport envelope. Ordinary API
requests retain their 65,536-byte limit. Both declared and streamed bodies are
bounded; the transport also has a 1 MiB ceiling. Authentication, source binding
and item-count validation still apply to the larger report route.

`deploy/monitoring/update_inventory.py` reads APT's installed/candidate versions
using python3-apt, explicitly configured runtime executables, an OpenClaw package
manifest and optional allowlisted local Docker projects. It never runs
`apt update`, installs packages, pulls image layers or controls containers.
For Debian/Ubuntu/PVE/PBS use the host's normal repository refresh mechanism.
Reports older than 26 hours, incomplete reports and APT indexes older than 48 hours
are stale. Candidate versions reflect configured repositories, including package
holds; they are not a promise that upgrading has been tested.

Run the collector daily using the host's existing scoped Doppler delivery:

```sh
doppler run --no-fallback -- python3 /srv/homelab/monitoring/update_inventory.py --config /srv/homelab/monitoring/update-inventory.json
```

Its environment needs `HOMELAB_DASHBOARD_ORIGIN` and that source's own
`HOMELAB_DASHBOARD_UPDATE_TOKEN`. Do not store the token in the JSON, arguments,
repository or a plaintext backup. The JSON contains nonsecret paths only:

```json
{
    "apt": true,
    "executables": { "bun": "/usr/local/bin/bun" },
    "dockerProjects": []
}
```

Optional executable names are `bun`, `node`, `github-cli`; OpenClaw uses
`openclawManifest` rather than loading identity state. Docker inventory requires
local daemon access, which is security-sensitive even for read-only commands.
Do not grant it merely to enable this collector; qualify host access separately.
Non-APT appliances require a publisher implementing the same validated report
contract. Unsupported sources remain absent/unknown, not falsely current.
The native publisher reports success only after the API explicitly accepts the observation.
Rejected out-of-order timestamps and malformed receipts fail delivery rather than reporting success.

The hourly `updates.releases` job compares Bun, current Node, OpenClaw and GitHub CLI
against fixed official release feeds. Stable latest releases are used, not project
dependency RC channels. Public Docker Hub/GHCR tag checks compare the correct
platform's image configuration digest with the locally observed image ID.
No images are pulled. Private registries, unsupported registries and digest pins
are explicitly unchecked. A tag check detects movement of that tag; it does not
guess a newer version tag or suggest replacing a deliberate pin.
Lookups have bounded concurrency, response sizes and deadlines. Least-recently
checked sources are processed first; unavailable feeds remain unknown.

Source summaries exclude package arrays. Software lists fetch at most 100 items
per request with automatic cursor continuation and shared virtual scrolling.
Permissions separate read, publish and manually triggering collection jobs.

## Deployment and acceptance

This change requires one new dashboard migration; published migration history
is retained. Stop workers, migrate the dedicated dashboard database, then start
web and worker using the same release digest. No production integration is
activated merely by checking out this branch.

The disposable preview seeds synthetic incidents and package lists. Without an
explicit preview metrics URL it also supplies synthetic backup metrics. Existing
read-only telemetry may be used in preview without real identity/control data.
Stop normally to remove the preview's database and fixture listeners.

Production qualification still needs scoped source accounts/tokens, collector
timers, a read-only Alertmanager route and verified log selectors. Existing
Pushover routing stays unchanged; dashboard notifications do not replace it.

# Snapshot catalog and rule inventory

Snapshot metadata and loaded alerting rules are independent read-only integrations;
neither is inferred from firing incidents or backup task history.

- `HOMELAB_DASHBOARD_RULES_URL` is the deployment-owned vmalert/Prometheus-compatible
  base URL. `HOMELAB_DASHBOARD_RULES_TOKEN` is optional bearer authentication.
  The worker reads only `GET /api/v1/rules`, every minute. All loaded alerting rules,
  including inactive and heartbeat rules, are listed; recording rules are excluded.
  Three-minute-old snapshots or missed evaluations become unknown, never normal.
  Unloaded/disabled rules cannot be inferred from this API. Raw expressions,
  annotations, labels and provider error messages are not stored or displayed.
- `HOMELAB_DASHBOARD_PBS_URL` is a trusted HTTPS PBS origin.
  `HOMELAB_DASHBOARD_PBS_TOKEN` contains `user@realm!token=secret` from Doppler.
  Use a dedicated audit-only account/token, scoped to the selected datastores;
  do not grant backup, prune, modify or restore permissions.
  `HOMELAB_DASHBOARD_PBS_STORES` explicitly lists the datastores and namespaces,
  e.g. `[{"datastore":"backups","namespace":""}]`. Namespaces are not recursively
  discovered. The worker reads only snapshot-list metadata every five minutes.
  Group counts and latest logical sizes accompany cursor-paginated snapshot details,
  recorded verification status and protection state. Logical size is not physical
  datastore usage: PBS deduplication/compression makes these different quantities.
  File lists, owner names, comments and backup content are never retained.
  Catalogs older than fifteen minutes remain visibly stale. Stale or unconfigured
  catalogs and failed detail queries show unknown verification and protection state.
  Removed rule configuration also makes retained rule health unavailable. Failed/partial reads do
  not replace a previously complete catalog. Maximum 5,000 snapshots and 2 MB per
  upstream response; exceeding a bound fails visibly rather than truncating counts.

These scopes require separate deployment provisioning. The interactive preview
uses an isolated synthetic PBS catalog and rule service. It does not create API
tokens or alter production routing. See the official
[vmalert API](https://docs.victoriametrics.com/victoriametrics/url-examples/) and
[PBS access-control reference](https://pbs.proxmox.com/docs/user-management.html).
