# Independent deployment

The definitions build auth and dashboard separately. They **do not** replace Authelia, modify
DNS/Traefik, provision a database, fetch credentials or expose WAN ports.

```sh
docker compose -f deploy/compose.yaml build auth
docker compose -f deploy/compose.yaml build dashboard
```

Set `HOMELAB_AUTH_EMAIL_FROM` to a single mailbox such as `noreply@example.test` or
an unquoted simple display name such as `Homelab Notifications <noreply@example.test>`.
Display names support letters, numbers, spaces, periods, underscores, apostrophes and hyphens;
address lists, comments and folded headers are not supported. Startup validates the syntax,
but the sender domain must also be verified in Resend before production mail is enabled.

Supply only the selected app's scoped environment and use
`docker compose -f deploy/compose.yaml up -d --no-deps auth` (or `dashboard`).
Unprovided variables remain absent; runtime validation fails closed. Do not print
`docker compose config` with real secrets or store its expanded output in Git.

This Compose file is a single-host verification definition, not a multi-host orchestrator.
Dashboard maps to loopback 3110 and auth to loopback 3111. Both run as Bun's unprivileged user,
with read-only root filesystems, dropped capabilities, bounded logs and no source mounts.
Auth mounts only the reviewed policy file read-only at `/etc/homelab-auth/access-policy.yml`.
That is also the default host path; `HOMELAB_AUTH_POLICY_FILE` may override the host path.
The file must exist and be readable by the container user before starting auth. Compose never
creates it automatically. Dashboard-only builds and starts do not require that file or variable.
Deploy them separately on Main and Edge using the existing approved private network pattern.
No Docker daemon, development package installation or source tree is needed inside either app.

## Built artifact

Each application's complete `dist` directory is its runtime artifact. Start from that directory
with `bun --no-env-file index.js` and `NODE_ENV=production`, or use the repository's
`start:auth` / `start:dashboard` scripts. HTML assets resolve relative to the working directory.
Auth also contains `admin.js` and reviewed `migrations/`.

Migrate with the same scoped auth environment and an explicit operator invocation:
`bun --no-env-file admin.js migrate`. Startup does not migrate. Build/tag from a reviewed commit;
the example image tags are not a production update policy.

## TLS and trusted proxy

Use the existing Edge wildcard certificate lifecycle and HTTPS routing. Production auth's
database also requires verified TLS. Do not expose the loopback OIDC adapter listener, publish
auth directly to WAN, trust arbitrary forwarded headers or forward the proxy key to an app.

The illustrative middleware file `traefik.example.yaml` is **not installed automatically**.
Review its addresses and attach it only to approved test routes first. Its Go-template value
reads the dedicated proxy key from Traefik's scoped environment; never replace it with a
literal committed secret.

The sequence is important: clear untrusted identity headers, add the proxy credential, run
ForwardAuth, then strip the proxy credential before the backend. ForwardAuth creates its own
forwarded request metadata. Pass cookies, not browser Authorization headers, to this check.
The callback path `/.homelab/sso/callback` must traverse the same middleware; it must not be
sent directly to a backend that cannot redeem it.

The identity issuer itself must not use ForwardAuth (that creates a login loop). Its API may
receive the proxy credential for trusted client-IP rate accounting, but that credential is
not permission to skip login or MFA. Configure the edge's trusted upstream IP ranges explicitly,
and discard user-supplied forwarded identity/IP metadata.

Preserve the full set of existing public media, WebDAV/mobile and API exceptions. Do not
automatically attach the middleware to every `*.example.test` host. A browser redirect is
not an appropriate auth method for all clients.

See [operations](../docs/identity-operations.md) for Doppler, backup, physical-device tests,
monitoring and the explicit production cutover gate.

## Published images

For production, wait for the release's **Container images** workflow and download its
`container-images.json`. Each application has its own GHCR digest reference and Compose
override. Supply only the selected app's scoped runtime environment and the corresponding
nonsecret image reference:

```sh
export HOMELAB_AUTH_IMAGE='ghcr.io/rajohan/homelab/auth@sha256:<auth-digest-from-release>'
docker compose -f deploy/compose.yaml -f deploy/compose.auth-image.yaml pull auth
docker compose -f deploy/compose.yaml -f deploy/compose.auth-image.yaml up -d --no-build --no-deps auth
```

On Main, deploy dashboard independently:

```sh
export HOMELAB_DASHBOARD_IMAGE='ghcr.io/rajohan/homelab/dashboard@sha256:<dashboard-digest-from-release>'
docker compose -f deploy/compose.yaml -f deploy/compose.dashboard-image.yaml pull dashboard
docker compose -f deploy/compose.yaml -f deploy/compose.dashboard-image.yaml up -d --no-build --no-deps dashboard
```

The selected override removes its build definition with Compose's supported `!reset` tag.
It requires its image reference and never requires the other application's image variable.
Use a current Docker Compose supporting `!reset`; the homelab's Compose supports it.
Authenticate to these private packages with a scoped read-only registry credential, not the
release workflow token or an editor's broad personal token.

These commands illustrate artifact selection, **not approval to deploy**. Database provisioning,
migration, policy installation, ingress routing, runtime credentials, backup and the approved
Authelia cutover still follow the operations guide. Publication itself never accesses the
homelab or restarts a service.

For local container validation, build both images with tags `homelab-release/auth:tested`
and `homelab-release/dashboard:tested`, set `HOMELAB_SMOKE_IMAGE_PREFIX=homelab-release`, and
run `bun run test:smoke` with a disposable `HOMELAB_TEST_DATABASE_URL`.
The same tests normally run local artifacts when the image prefix is absent.
Container smoke tests require Linux Docker host networking for their loopback-only database
and OIDC endpoints. They run as the image's unprivileged user with a read-only root filesystem,
no capabilities, a bounded temporary directory and only the synthetic policy mounted read-only.
Their exact temporary containers are removed on success or failure.

## Package metadata before inventory

The inventory collector reads installed versions and existing package lists; publishing
a fresh report does not itself refresh APT metadata. The dashboard considers OS reports
stale when their package-list timestamp is missing or more than 48 hours old.

For an explicitly approved host whose normal `apt-daily` refresh is unavailable,
`monitoring/homelab-update-inventory-refresh.conf` is an optional per-instance drop-in
for `homelab-update-inventory@<source>.service`. Install it root-owned under that
instance's `.service.d` directory and reload systemd. It runs only `apt-get update`
before the existing publisher, never `install`, `upgrade`, service restarts or reboots.
APT must already maintain `/var/lib/apt/periodic/update-success-stamp` through its
standard success hook. Any repository refresh failure prevents a new report.

The `+` prefix gives only this fixed APT preparation command its normal root context
(including its own `_apt` privilege drop); the publisher retains its existing sandbox.
This avoids releasing unrelated package-upgrade jobs queued behind incomplete
cloud-init provisioning. It does not repair or resume cloud-init itself. Qualify the
host's APT sources/hooks first, compare installed package versions before and after,
and verify both report and package-list timestamps. Do not install the drop-in globally.
