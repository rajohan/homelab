# Infrastructure visibility

The dashboard reads monitoring data. It cannot start, stop, resize or reconfigure
hosts or applications. There is no Proxmox administrator credential in the web app.

## Collection and history

The existing `infrastructure.metrics` job runs every minute. It writes the compact
overview and the detailed inventory atomically to `operation_snapshots`. The job's
lease fence prevents a superseded worker from publishing its result. No database
migration is needed for these two snapshot keys.

The browser polls current inventory every five seconds while visible. The server
shares in-flight collection and caches each attempt for five seconds per process;
it does not persist every poll or create background jobs while the page is closed.
Collection failures remain errors rather than passing old values off as fresh.
When the API succeeds but a known exporter is down, the last successful inventory
retains that source's resource identities with unknown health and null measurements.
Fresh sources continue to update and remain authoritative for actual deletions.
Live reads retain their successful baseline in memory; restarted dashboard processes
and workers seed it from the saved snapshot. No historical measurements are copied
forward and polling still performs no database writes.
Without configured monitoring, the API can still read the saved worker snapshot.
Opening a host or application
queries only that resource's historical measurements, polled once per minute.
Focus and reconnect also refresh the view. Supported windows are 1 hour, 6 hours, 24 hours and 7 days. History stays in
the monitoring system, not a second dashboard time-series database.

Both processes use `HOMELAB_DASHBOARD_METRICS_URL` and, where required,
`HOMELAB_DASHBOARD_METRICS_TOKEN`. The worker needs these for collection; the web
process needs them for historical queries. A scoped read-only monitoring proxy
need only allow GET requests to `/api/v1/query`; bounded PromQL subqueries provide
history through that existing route. Do not expose write, administrative or
arbitrary proxy endpoints. Tokens are server-only.

`infrastructure:read` protects both inventory and history. History accepts saved
host IDs, saved interface/disk selections, and a fixed time-window enum, never a
URL or arbitrary PromQL. Queries have deadlines, response-size limits, result
limits and point limits. Upstream error bodies are not exposed to the browser.

## Metric sources

- Proxmox exporter: node, guest and storage inventory; CPU allocation, CPU usage,
  memory allocation and resident memory; uptime, disk allocation and guest I/O.
- Node exporter: actual OS memory, CPU, swap, load, filesystems, interface traffic,
  errors/drops, block-device throughput/IOPS/busy time and native systemd services.
- Home Assistant System Monitor: paired disk-use/free sensors provide filesystem
  usage when no native filesystem metrics exist. Both sensors and their exporter
  must be available; reported capacity is the sum of their rounded used/free values.
- SMART exporter: physical disk health, temperature and reported endurance used.
- Application collector: expected/present/running/ready state, restart count,
  start time and healthcheck presence, guarded by collector freshness.
- Docker resources: the existing host collector reads one-shot stats over its local
  Unix socket for approved inventory containers only. It exports numeric
  `homelab_container_*` counters/gauges labelled by project and service; node exporter
  adds the host. The dashboard never receives Docker socket access or credentials.
  Collection is bounded independently of application health; failures produce
  unknown resource values, not zero usage. No additional exporter container is needed.
- Blackbox exporter: end-to-end checks, shown separately from exporter reachability.
- Native application resources: a small allowlisted collector reads systemd and
  cgroup v2 counters as node-exporter, without administrator rights, network access
  or Linux capabilities. Only its own `/var/lib/homelab-native-resources` directory
  is writable. A single `native-resources.prom` symlink in the existing textfile
  directory exposes that numeric output without granting write access to other
  monitoring files. It exports
  `homelab_native_*` numeric metrics through the same node-exporter textfile endpoint.
  The collector source, configuration and unit files are in `deploy/monitoring`.
  No process command lines, environments, application credentials or log content
  are read. Network and I/O accounting are enabled only on the selected units;
  resource limits and firewall policy are unchanged.

The fixed metric names live in the metrics integration's catalog, not in UI code.
The integration uses `host` and `job` labels for guest telemetry and
`instance`/`id` for Proxmox resources. Guest-name joins are allowed only when unique
across the Proxmox inventory. Duplicate names do not silently merge two machines.
Additional node-exporter hosts remain visible outside the Proxmox guest list.
Templates are excluded; stopped guests remain listed.

The PVE metric contract is checked against
[prometheus-pve-exporter v3.10.0](https://github.com/prometheus-pve/prometheus-pve-exporter/blob/316e9d912f2ea023bfb2866f9ea107537b91e528/src/pve_exporter/collector/cluster.py):
`pve_node_info` identifies nodes with `name` (not `node`), and
`pve_storage_info` describes backends with `plugintype` (not `type`).
Agentless guest history uses the current counters `pve_network_receive_bytes_total`,
`pve_network_transmit_bytes_total`, `pve_disk_read_bytes_total`, and
`pve_disk_written_bytes_total`. That exporter also exposes deprecated gauge aliases;
the integration deliberately uses the counter replacements. Unit tests cover these
upstream labels and all four history expressions with synthetic data.

## Interpretation

- **OS memory used** is total minus available. **Assigned memory** is the PVE
  allocation. Hypervisor resident memory includes guest cache and is labelled as
  such when guest measurements are unavailable. LXC CPU uses PVE measurements
  because guest `/proc` CPU counters may describe the host.
- **Filesystem usage**, **hypervisor disk allocation**, **pool capacity**, and
  **block I/O** are different measurements. They are not substituted for each other.
- Pools, datasets and bind mounts can share capacity. They are never summed into
  a misleading homelab-wide free-space total.
- Host rows show each filesystem's used/total bar, not allocated virtual-disk size.
  Boot partitions remain in the detail view, but are omitted from the compact overview.
  Hypervisor rows show only the root filesystem;
  their storage pools have their own overview. All datasets and mounts remain in
  the host's Filesystems detail view. Nothing is removed from collection.
- Interface rows and charts are independent. Bridges, virtual interfaces and
  physical ports can count the same traffic. Virtual interfaces are initially
  hidden in the detailed table but remain available explicitly.
- Current CPU, network and I/O values use the latest counter pair within a one-minute
  lookback. Historical rate charts retain five-minute averages. Wider chart windows sample fewer points and can
  miss short peaks. Counter resets are handled by the monitoring query engine.
- Null means **not reported**, not zero. Unknown exporters or stale application
  collectors never become healthy by default. A failed refresh keeps the last
  snapshot and marks its age; it does not replace every resource with an empty list.
- Container restart counts describe the current container instance and may reset
  when it is replaced. Readiness without an application healthcheck is explicitly
  distinguished from a configured healthcheck.
- Application CPU follows Linux `docker stats`: 100% means one fully used logical
  CPU, 200% means two. Both Docker and native applications use CPU seconds per
  elapsed second multiplied by 100, without dividing by host cores or CPU quotas.
  Values may exceed 100%; charts do not clip them. Hosts and guests retain
  utilization relative to their total CPU capacity. Current app values use the
  latest counter pair; chart values retain five-minute averages.
  Memory is the working set (usage minus inactive file cache), compared with the
  smaller of a positive configured cgroup limit and the host's total OS memory.
  A zero configured limit falls back to host RAM; an unknown limit stays unknown.
  Capacity is shared, not a reservation or the host's currently free memory.
  Memory charts for applications and hosts include a capacity series measured at
  each historical sample, never a retrospective copy of today's allocation.
  The memory axis ends at the highest capacity in the selected window without
  rounding it upward; any genuinely higher usage sample remains visible.
- Container network counters describe its network namespace. Shared VPN/host
  namespaces can overlap; do not sum them. Docker block-I/O totals may count stacked
  devices more than once and do not represent physical throughput or disk capacity.
  PIDs include threads.
- Native applications use their own cgroup working set and tasks. Their
  memory limits include ancestor ceilings and the displayed capacity is capped by
  the VM's total OS memory, using the same rules as Docker applications.
  Nextcloud groups its dedicated nginx/PHP-FPM services and active background
  job units; its Valkey service remains a separate application. Gateway, pgAdmin
  and Samba each use their own service cgroup. Overlapping unit groups are rejected.
  CPU/network/I/O counters remain per unit: monitoring calculates rates **before**
  summing, so restarting one unit cannot reset another unit's counter. Inactive
  optional job units are excluded; short jobs entirely between samples can be missed.
  IP accounting measures IPv4/IPv6 socket traffic, not Unix sockets. Internal
  exchanges between grouped units can appear on both sides of their counters;
  these are application activity, not deduplicated external bandwidth. Unavailable
  accounting remains unknown rather than reporting partial totals as complete.
- Container history begins when collection is enabled. Missing counters, failed
  collection, stopped containers and samples older than three minutes are gaps.
  Rate charts need multiple samples after collection starts.

## Automatic refresh

`queryRefresh` in shared UI defines polling, focus and reconnect behavior.
Job queues, workers, schedules and run details refresh every 5 seconds;
infrastructure every 5 seconds; session identity every 15 seconds; account settings, automation
access, activity and system status every 30 seconds; chart history every 60 seconds.
Polling pauses in background tabs and resumes when focused or reconnected.
Mutations still invalidate affected queries immediately. Open forms retain their
unsaved values during refresh. Interactive verification challenges are not polled.

These are browser refresh intervals, not guarantees of end-to-end latency. Current
inventory queries use VictoriaMetrics' one-second ingestion allowance instead of
its default thirty-second query offset. Historical queries keep the default.

The monitoring deployment collects CPU, RAM, network and disk-I/O counters every
five seconds. Dedicated filtered scrapes preserve existing metric labels and do not
duplicate series. Filesystem capacity, PVE inventory/storage and Home Assistant
filesystem sensors are scraped every sixty seconds; unrelated monitoring remains
unchanged. Source-side caching (including PVE's own statistics) still limits how
often an underlying value can change.

On Docker hosts, the existing approved collector supports a resource-only mode,
run by `homelab-container-resources.timer` every five seconds. Health checks retain
their minute cadence. Resource-only collection excludes native HTTP health probes
and writes atomically to its own textfile. No containers are restarted. The worker's
minute snapshots remain for background summaries, independently of live reads.

`homelab-native-resources.timer` collects the native allowlist every five seconds.
The existing fast scrape includes these metrics and the slower scrape excludes
them to avoid duplicate series. `metrics_success` and sample freshness guard both
current values and history; an accounting failure never changes app health.
Native history begins at deployment, without copying host history into app graphs.

The native collector tests use temporary synthetic cgroups and clean them up:
`PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s deploy/monitoring -p 'test_*.py'`.

## Local preview

`bun run dev:identity` remains fully isolated by default. To preview real **read-only
telemetry** while keeping identity and dashboard databases disposable, explicitly
set `HOMELAB_PREVIEW_METRICS_URL` to an endpoint the development host may read. Do
not use production identity/database credentials. Stop with Ctrl+C to remove the
owned development database and all synthetic accounts.

The monitoring integration is tested with local synthetic HTTP responses and
disposable PostgreSQL databases. Chart data preparation and resource normalization
have unit tests; UI states have Happy DOM tests. Browser inspection is still needed
for chart sizing, keyboard navigation and narrow-screen layout.
