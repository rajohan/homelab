# Confirmed release deployment

The release panel can prepare and deploy the latest verified stable release. A recently verified human with `updates:apply` and `jobs:run` confirms the exact prepared version. Preparation is a read-only job; deployment is a separate durable operation so replacement never consumes a job lane or depends on the worker staying alive.

This is opt-in. Initial installation must deploy the new schema and deployment-capable worker and Mira together. Leave `HOMELAB_DASHBOARD_DEPLOYMENT_TARGETS` unset until the host recipe has been qualified. Automatic deployment is not enabled by this setting. Authentication remains independently deployed.

## Configuration

Pass the same nonsecret JSON array as `HOMELAB_DASHBOARD_DEPLOYMENT_TARGETS` to dashboard and worker. Each entry has:

```json
{
    "id": "main",
    "label": "Dashboard and Mira",
    "connection": "main",
    "project": "homelab",
    "directory": "/etc/homelab",
    "composeFile": "/etc/homelab/compose.yaml",
    "stateDirectory": "/var/lib/homelab-releases",
    "composeCommand": ["/etc/homelab/compose.sh"],
    "backupCommand": [
        "/etc/homelab/with-secrets.sh",
        "/usr/bin/python3",
        "{runner}",
        "backup"
    ],
    "migrateCommand": ["/etc/homelab/migrate.sh", "{image}"],
    "mira": true,
    "services": [
        { "name": "dashboard", "app": "dashboard" },
        { "name": "worker", "app": "dashboard" },
        { "name": "mira", "app": "mira" }
    ],
    "units": [
        "homelab-dashboard.service",
        "homelab-worker.service",
        "homelab-mira.service"
    ]
}
```

Paths and commands are existing operator-owned deployment configuration, never shell text supplied by a browser or model. The example paths are placeholders, not installed helpers. Use the host's current secrets/Compose/migration entrypoints. The Compose command must accept `--project-name <project> config --format json`, resolve its own environment during preparation, and use exactly `composeFile`. The migration command must run the confirmed dashboard image's `migrate.js --apply` against the same database, return nonzero on failure, and remove its one-off container. Only complete argument tokens `{runner}` and `{image}` are substituted. The backup wrapper must expose `HOMELAB_DASHBOARD_DATABASE_URL` to the fixed `backup` helper; the helper translates its connection fields into separate libpq environment variables, never argv or the receipt. The host’s `pg_dump`/`pg_restore` must support the deployed PostgreSQL version. Standard TLS URL options are supported; unknown or repeated URL options are refused.

An optional private `environmentFile` is loaded by systemd for the runner, and may supply `DOPPLER_TOKEN` or `DOCKER_CONFIG`. It does not configure the preparation SSH process. An optional `browserConfigFile` identifies the existing browser-service JSON; configure its proxy service as `mira-browser-proxy` in `services`. Both browser images must have matching release-workflow evidence. The runtime image is updated by immutable Docker image ID after pull and OCI-label verification.

This recipe manages one complete dashboard/worker/Mira deployment sharing one database. Include every service and systemd unit that owns those containers. Units must recreate their containers from the configured Compose file when started, and must not regenerate that file or apply database migrations implicitly. Every selected service requires a Docker healthcheck. The source must use literal immutable image pins; aliases, interpolated images and local source overrides require separate qualification. State and configuration files must be owned by the SSH execution user (normally root), without group/world write access. The state directory must already exist with mode `0700`. The account needs existing scoped authority for Docker, systemd and those paths. No new SSH identity or trust is created.

## Execution and recovery

1. Preparation verifies official publication evidence and observes the complete rendered Compose configuration, image references, containers and systemd invocations. Confirmation expires after five minutes.
2. Admission atomically freezes new worker claims. Mira finishes admitted operations and acknowledges the exact deployment ID. Browser processes must finish cleanup. Existing queue pause settings are preserved. A waiting deployment can be cancelled; after submission it can only be inspected.
3. The coordinator waits at most thirty minutes for active work and revalidates publication before submission. The host rechecks the frozen observations, acquires the deployment-directory lock, pulls exact digests and verifies version/revision/platform labels.
4. A systemd transient service owns the replacement independently of SSH and the replaced worker. It stops the selected units, writes a private PostgreSQL custom-format backup and checks it with `pg_restore --list`, preserves the original files, changes only approved image pins, and checks the complete rendered configuration before migration.
5. After migration, it starts the units and checks exact image IDs, references and health. A durable host receipt allows the replacement worker to finish the operation and reopen the queue.

The host stores `intent.json`, `runner.py`, `status.json`, `compose.before`, optional `browser.before` and `database.dump` under `<stateDirectory>/<operation-id>`. The dashboard never exposes command output, expanded Compose secrets or backup contents. A submission is never replayed after a lost acknowledgement. An interrupted runner or uncertain migration leaves the queue closed.

Failures before migration restore the original pins and only resume after verifying the previous services. After migration starts, do not restore an old image alone. Stop the affected units, inspect the journal and backup, restore the correct database/configuration using the existing operator procedure, and verify the original services. The staged runner provides an operator-only final verification:

```text
/usr/bin/python3 -I -B <operation-directory>/runner.py recover <operation-directory> --database-restored
```

`--database-restored` is an explicit operator attestation, not an automatic database restore. It is required if migration may have started. Recovery refuses an active runner or configuration/images that differ from the recorded originals. Once verification succeeds, the coordinator records the recovered failure and allows queued work to continue. No web/API action can assert database recovery. If submission has no host journal, investigate the original SSH process and the operation's database record before operator recovery; do not resubmit that operation ID.

The runner has a thirty-minute systemd lifetime, bounded command output and a 512 MiB backup ceiling. Admission requires 1 GiB free space and fewer than 100 retained operation directories. Backups are not automatically deleted. Review and archive completed history using the host's existing backup policy before these limits are reached. An interrupted or failed operation's files must remain available for recovery.

## Qualification

The ordinary Bun suites cover admission, MFA, frozen confirmation, queue draining, lost acknowledgements, concurrent controllers and migration failure. The worker integration test keeps local cleanup running after its durable claim has ended and verifies that replacement still waits. Host unit tests exercise file permissions, exact replay prevention, process limits and recovery.

For a separately approved disposable Linux host with Docker, systemd and PostgreSQL client tools, run `sudo /usr/bin/python3 -I -B scripts/smokeReleaseDeployment.py`. This qualification creates uniquely named synthetic units, images, containers and a database; its cleanup removes only those test resources. It checks independent systemd ownership, successful replacement, interruption during migration and verified database restoration. Test-only registry transport maps local synthetic images to immutable fixture references; it does not prove registry publication or credentials. The actual publication reader and host image checks remain enabled in production.

The native qualification is a local operator test, not a privileged pull-request CI job. Do not run it against production services or treat unit tests alone as qualification of a new host recipe.
