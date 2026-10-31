# Release deployment

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

For a browser configuration containing public-network slots, also set `browserProxyUnits` to the one or two existing units that own **only** the selected proxy containers. These units must be a proper subset of `units`; keep the browser host, dashboard and executor in the remaining units. For example, add `"browserProxyUnits": ["homelab-browser-proxies.service"]` and include that unit in `units`. Each configured slot must match one selected proxy service by its current immutable container and image IDs. Missing or ambiguous mappings are refused during preparation. Preparation allows active browser sessions; admission then waits for their cleanup. Submission and execution require unchanged isolated IPv4 network identities and the proxy as each slot's sole remaining peer.

After migration the runner starts and verifies only the proxy units, rewrites the saved `proxyId` and `proxyImageId` values using the verified replacements, and then starts the other units. It preserves the browser-host UUID, socket, network identities and other configuration. The proxy units must not start other selected services, and starting the remaining units must not recreate those proxies. Final verification checks the same IDs again. A failure after migration retains the deployment hold for operator recovery; it never reports successful browser activation with stale proxy IDs. Offline browser configurations without network slots need no proxy startup units.

This recipe manages one complete dashboard/worker/Mira deployment sharing one database. Include every service and systemd unit that owns those containers. Units must recreate their containers from the configured Compose file when started, and must not regenerate that file or apply database migrations implicitly. Every selected service requires a Docker healthcheck. The source must use literal immutable image pins; aliases, interpolated images and local source overrides require separate qualification. State and configuration files must be owned by the SSH execution user (normally root), without group/world write access. The state directory must already exist with mode `0700`. The account needs existing scoped authority for Docker, systemd and those paths. No new SSH identity or trust is created.

## Automatic deployment policy

Each target starts in **Manual**. In the release card, **Edit policy** can authorize stable patch releases or stable patch and minor releases during a daily 15–240 minute maintenance window. Saving or pausing a policy requires a recently verified human with `updates:configure`, `updates:apply` and `jobs:run`. The policy binds the current host recipe, SSH authority and server timezone. Configuration or timezone changes suspend automatic admission until the policy is saved again. Merely configuring a target never enables automatic deployment.

The scheduled `homelab.automatic` check uses the existing network job lane every five minutes and respects ordinary queue and schedule pauses. User-started checks enforce the same policy and window. A policy can be paused independently, with a reason and optional resume time. Saving a changed scope preserves an existing pause. Times follow the server clock shown in the editor; a nonexistent start during the spring DST transition is skipped. Window duration is elapsed time from its scheduled start, including across midnight.

Automatic deployment requires every configured service to run an older stable version in the authorized range. Major releases, prereleases, equal versions and downgrades are never admitted. The official container publication includes a SHA-256 identity for the ordered dashboard migration SQL programs and their directory names. Tested dashboard and Mira images carry the same `io.homelab.dashboard-schema` label. Automatic admission requires the candidate's verified publication identity to match the actual installed core images; Compose label overrides cannot supply this evidence. Missing or changed migration evidence requires manual deployment. This is a schema-compatibility gate, not a guarantee of application compatibility or automatic database rollback.

An admitted operation uses the same durable queue drain, backup, host execution and completion verification as manual deployment. Policy version and the original window are checked again under the queue lock immediately before submission. Pausing or changing a policy while it waits cancels it before replacement; work already submitted is allowed to finish. Cancelled candidates are not re-admitted during the same window. Failed, uncertain or previously successful automatic candidates are not silently retried. Recovery and any intentional retry use the existing manual controls. The thirty-minute drain limit and bounded host execution still apply.

The initial release introducing this feature requires the ordinary qualified manual installation. Older releases lack the required migration evidence. Authentication remains independently deployed and is not included in a dashboard/Mira policy.

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

If restoring the original proxy images recreates their containers, restore the original browser configuration and refresh only its proxy container/image IDs from the verified original services. Start proxies first, then update the file, then start the browser host and remaining services. Recovery accepts these identity changes only when the network identities and every other browser setting match the original backup and the actual proxies match the original image IDs. A stale proxy ID or a different browser image, host UUID, socket or network keeps recovery blocked. The recovery verifier does not edit files or restore the database for the operator.

The runner has a thirty-minute systemd lifetime, bounded command output and a 512 MiB backup ceiling. Admission requires 1 GiB free space and fewer than 100 retained operation directories. Backups are not automatically deleted. Review and archive completed history using the host's existing backup policy before these limits are reached. An interrupted or failed operation's files must remain available for recovery.

## Qualification

The ordinary Bun suites cover admission, MFA, frozen confirmation, queue draining, lost acknowledgements, concurrent controllers and migration failure. The worker integration test keeps local cleanup running after its durable claim has ended and verifies that replacement still waits. Host unit tests exercise file permissions, exact replay prevention, process limits and recovery.

For a separately approved disposable Linux host with Docker, systemd and PostgreSQL client tools, run `sudo /usr/bin/python3 -I -B scripts/smokeReleaseDeployment.py`. This qualification creates uniquely named synthetic units, images, containers and a database; its cleanup removes only those test resources. It checks independent systemd ownership, successful replacement, interruption during migration and verified database restoration. Test-only registry transport maps local synthetic images to immutable fixture references; it does not prove registry publication or credentials. The actual publication reader and host image checks remain enabled in production.

The native qualification is a local operator test, not a privileged pull-request CI job. Do not run it against production services or treat unit tests alone as qualification of a new host recipe.

`python3 -I -B scripts/smokeDashboardUpgrade.py <previous-local-image> <candidate-local-image>` separately rehearses the packaged dashboard migration and database restore. Both images and `postgres:18` must already exist locally. The previous image creates its schema in a private, disposable database, then the fixture adds synthetic paused schedules, update holds, queue controls, audit/snapshot history and notification read state. The candidate migrates twice, preserves the original fields, starts dashboard/worker with the reserved light-job capacity, and the test restores the backup into the same database before starting the previous image again. Mismatched schema/image combinations must remain unready. It never reads production data or imports provider credentials.

Production qualification on 2026-10-31 passed this rehearsal from the installed 0.9.0 artifact to the post-#142 schema. The separately approved Mira profile also passed packaged text/PDF/image input, recorded tools, continuation after container replacement and provider-history cleanup. These results do not by themselves activate production or qualify the actual Windows PC and external providers.

After building the reviewed `homelab-browser-proxy-test:local` image, `python3 -I -B scripts/smokeBrowserDeployment.py` replaces both real proxies in disposable offline networks. It verifies that network IDs stay fixed, old container/image IDs are refused, and the refreshed IDs pass the production browser egress guard. This complements the host-journal tests for startup ordering, concurrent file edits, failures and operator recovery.
