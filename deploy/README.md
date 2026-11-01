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

## Optional Mira and private computer receiver

Add `compose.mira.yaml` to the dashboard/worker deployment to supply Mira's tested
image, dedicated runtime profile and shared files. It forwards the nonsecret
`HOMELAB_MIRA_GITHUB_OWNER` to dashboard and executor, and the dedicated
`HOMELAB_MIRA_GITHUB_TOKEN` only to the executor. The owner is the Homelab operator
ID, not a GitHub login. The adapter separately verifies `mira-2026`. Unset values
leave the integration unavailable; this overlay never discovers CLI credentials.

The computer receiver remains disabled unless `compose.computer.yaml` is also
selected. It binds to a fixed private **container** address and publishes only
`127.0.0.1:3113` on the Docker host. Do not use the host's Meshnet address as the
container bind address. Choose an unused bridge subnet and a dynamic allocation
pool that excludes the fixed dashboard address. Illustrative values, to replace
after checking existing host, VPN and Docker routes:

```dotenv
HOMELAB_MIRA_COMPUTER_SUBNET=172.30.113.0/24
HOMELAB_MIRA_COMPUTER_DYNAMIC_RANGE=172.30.113.128/25
HOMELAB_MIRA_COMPUTER_HOST=172.30.113.2
```

The separate dynamic pool prevents a worker or another service started first from
taking the dashboard address. Changing the default network's IPAM requires planned
network recreation; do not apply this overlay blindly to a running installation.
Use Docker Engine 28 or newer for the documented [loopback publication boundary](https://docs.docker.com/engine/network/port-publishing/).
The address and pool use standard [Compose IPAM](https://docs.docker.com/reference/compose-file/networks/#ipam).

A separately configured TLS proxy **on the same host** must forward the private
computer hostname to `http://127.0.0.1:3113`. Its listener, DNS and firewall must be
restricted to the approved Meshnet peers or their routed LAN path, including IPv6.
Do not add this upstream to the public dashboard router, publish `3113` on a
wildcard address or configure a public fallback. Keep browser `Origin`/`Cookie`
headers intact so the receiver can reject them. The PC uses outbound HTTPS and
opens no listener. Host administrators and containers on this bridge remain inside
the host trust boundary; the overlay is not tenant isolation.

The reviewed [nginx example](nginx/computer.conf.example) provides the same-host
private TLS boundary. Include it in nginx's `http` context after replacing all
placeholders: one exact private IPv4 address/port, the private DNS hostname, its
verified certificate/key paths, and the approved peer address or CIDR. Additional
peers require explicit entries in the `geo` block. Choose a port with no competing
wildcard listener; do not add IPv6, HTTP redirects, a public vhost or an Edge proxy
without separately qualifying that route. The certificate must cover the selected
hostname and be trusted by Windows. Use the existing certificate renewal owner;
nginx package updates remain part of the host's normal package updater.

The peer gate uses nginx's [original socket address](https://nginx.org/en/docs/http/ngx_http_realip_module.html#var_realip_remote_addr),
so inherited real-IP settings and forged forwarding headers cannot admit another
peer. It requires nginx's HTTP real-IP and SSL modules. This example expects a
direct PC connection through Meshnet or its approved routed LAN path, not another
HTTP proxy or a shared NAT gateway that hides peer identity. The TLS SNI and HTTP
host must both match the private name. Only machine protocol paths reach the
loopback receiver. Browser headers remain intact, access logging is disabled,
early data and proxy retries are disabled, and the 3 MiB limit accommodates command
results. The private Bun listener uses the same 3 MiB ceiling; the receiver still
limits control routes to 2 KiB. Request/response
buffering and caching are disabled; do not override these in inherited includes.

Before activation, review the rendered configuration and `nginx -T` output locally
without exposing certificate keys or real credentials. Verify routing, peer source
addresses, firewall rules, private DNS, public IPv4/IPv6 refusal and loss of the
Meshnet route from the actual Windows PC. A passing loopback fixture does not prove
that a production firewall or DNS zone is private. Provisioning and reload are
separate operator actions; the example and tests do not modify live nginx or DNS.

`HOMELAB_SMOKE_IMAGE_PREFIX=<local-image-prefix> PYTHONDONTWRITEBYTECODE=1 python3 scripts/smokeMiraDeployment.py`
qualifies the rendered overlays and actual dashboard image with disposable data.
It verifies GitHub credential placement, default-off configuration, loopback ports,
public endpoint refusal, private protocol boundaries, recreation and disabling.
It also builds the pinned test-only nginx image and exercises the actual example
against that receiver with a temporary TLS certificate: trusted/untrusted TLS,
allowed/denied peers, forged forwarding headers, SNI/Host mismatches, browser
headers and payload limits. Only loopback test listeners are used, and no real
certificate or device credential is required. This test image is never published;
Dependabot tracks its Docker pin as `ci(deps)` without triggering an app release.
The container-image workflow runs it before saving images for publication. This
does not qualify production TLS, firewall rules or the Windows PC; those need the
separate [computer acceptance checks](../docs/mira-computer.md).

## Built artifact

Each application's complete `dist` directory is its runtime artifact. Start from that directory
with `bun --no-env-file index.js` and `NODE_ENV=production`. From the repository root,
use `NODE_ENV=production bun --cwd apps/auth/dist --no-env-file index.js` (or
`apps/dashboard/dist` / `apps/mira/dist`). HTML assets resolve relative to the working directory.
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

### Isolated browser web access

`compose.browser.yaml` adds the trusted browser host and two separate browser slots. Merge it with the dashboard's deployment Compose project so the host can reach the same database. The dashboard, Mira model executor and browser workers do not receive the Docker socket. The browser host alone controls that local engine; a read-only socket mount still permits Docker API mutations and must be treated as host administrative authority.

The overlay requires Docker's `isolated` bridge gateway mode and Compose support for `interface_name` (2.36 or newer). Each slot is internal and has no host bridge address. It contains only its dedicated proxy and, while reserved, one browser. The two proxy containers share a separate outbound network, publish no ports and use their immutable, baked configuration. Public IPv4 HTTP/HTTPS on ports 80/443 is supported. IPv6-only sites and other destination ports are deliberately unavailable. TLS remains end to end; the proxy does not intercept certificates.

Squid resolves through 1.1.1.1 and 9.9.9.9 inside its own namespace. Both its address ACL and an independent nftables output policy reject loopback, private, link-local, CGNAT, reserved and multicast destinations, including DNS rebinding and redirects. The firewall permits DNS only to those two resolvers. The startup process installs namespace-local rules, then drops every capability before Squid serves requests. The health check requires that capless process. An unprivileged browser has no direct outbound route, and Chromium's fixed proxy policy includes loopback destinations rather than silently bypassing the proxy.

Provisioning uses the standard Compose overlay, not a second setup framework:

1. Pull the exact Mira image from `container-images.json` and both browser images from `browser-image.json` for the same reviewed release. Keep their immutable digest references. The release publisher publishes only images already qualified in CI.
2. Set `HOMELAB_MIRA_BROWSER_PROXY_IMAGE`, `HOMELAB_MIRA_IMAGE`, `HOMELAB_DOCKER_GID`, `HOMELAB_DOCKER_SOCKET`, `HOMELAB_DASHBOARD_DATABASE_URL`, `HOMELAB_MIRA_FILES_DIR` and `HOMELAB_MIRA_BROWSER_CONFIG`. The config file is nonsecret and must exist before starting the host. Do not pass model/provider credentials to this service.
3. Start only `mira-browser-proxy-a` and `mira-browser-proxy-b` with Compose. Read their immutable container IDs and image IDs with `docker inspect`, and the slot network IDs with `docker network inspect`. The browser worker image ID comes from `docker image inspect` after pulling its published digest.
4. Write the configuration below with those exact IDs and a stable host UUID. Inside the host container the canonical socket path is `/run/docker.sock`. Apply the dashboard migrations before starting `mira-browser-host`.
5. Start the host, verify its private health check, and qualify a disposable human-granted Chat session before enabling browser access for normal use.

```json
{
    "hostId": "00000000-0000-4000-8000-000000000001",
    "socketPath": "/run/docker.sock",
    "imageId": "sha256:<installed-browser-image-config-digest>",
    "networks": [
        {
            "networkId": "<slot-a-network-id>",
            "proxyId": "<proxy-a-container-id>",
            "proxyImageId": "sha256:<installed-proxy-image-config-digest>"
        },
        {
            "networkId": "<slot-b-network-id>",
            "proxyId": "<proxy-b-container-id>",
            "proxyImageId": "sha256:<installed-proxy-image-config-digest>"
        }
    ]
}
```

A missing `networks` property preserves the existing fully offline mode. The database reserves each configured slot until the original browser's removal is confirmed, including after host crashes. Before start and every two seconds while active, the host checks the exact proxy/image, healthy capless startup, isolated network and absence of other peers or browser routes. Losing that configuration retires the session; input is never replayed.

### Optional local code execution

The same trusted host can also dispatch reviewed Homelab source/check/edit jobs on Main, without a Daytona account. Chat, Automations and task Run share the Code execution setting. Existing settings continue to select Daytona until changed; each queued run freezes its choice. Jobs and Chat show both targets in Code jobs, and starting a draft requires its explicit target. Main has its own pause control under Integrations. It does not run arbitrary shell commands or mount production directories. Automatic dashboard improvement requires its separate policy for the selected execution target; selecting Main cannot silently use Daytona or cloud fallback.

1. Pull the qualified Homelab check image for the release and record its local immutable image ID. Start `mira-code-proxy` using `--profile local-code` with this Compose overlay. It uses a separate internal network from both browser slots. Inspect its immutable proxy/image and network IDs as above.
2. Save this nonsecret JSON in an operator-owned file: `{"kind":"main","owner":"<Homelab account ID>","hostId":"<same stable browser-host UUID>","imageId":"sha256:<check-image ID>","egress":{"networkId":"<code-network ID>","proxyId":"<code-proxy ID>","proxyImageId":"sha256:<proxy-image ID>"}}`. Set `HOMELAB_MIRA_LOCAL_CODE_FILE` to its host path and include `compose.local-code.yaml` after `compose.mira.yaml` and `compose.browser.yaml`; it mounts the same file read-only into dashboard, Mira and the trusted host. The existing inline `HOMELAB_MIRA_LOCAL_CODE` remains supported for manual deployments, but must not be combined with the file setting. No socket path or credentials belong in this value. Only the trusted host gets Docker access. The host refuses a mismatched host identity or a reused browser network/proxy.
3. Restart the three services with matching configuration, verify the fresh Main code execution status and enable it explicitly. Changing the host, image or network requires pausing and re-enabling that control. Keep the `local-code` Compose profile during subsequent deployment; the proxy uses the same restart policy as the browser proxies.

The host runs code independently of browser sessions, publishing availability every five seconds; a stale heartbeat prevents execution. One active code slot is shared with Daytona. Main containers have 4 CPUs, 8 GiB memory and bounded temporary storage; checks have a ten-minute deadline. Shutdown interrupts active execution, and the durable queue retains uncertain cleanup for the original host to reconcile. Cleanup continues while paused. Coordinated releases stop new local admissions and wait for active work, result collection and cleanup, preserving queued jobs. Add `localCodeConfigFile` and the code proxy to the [release recipe](../docs/release-deployment.md) so future releases update and back up this file with the browser configuration. Changed immutable bindings still require renewed Main consent, and queued jobs with an old binding return to review. An unconfigured deployment continues operating without local code execution.

For upgrades, stop accepting new browser sessions, allow active jobs to finish or explicitly stop them, and verify cleanup before recreating proxies. Recreating a proxy or network changes its immutable ID: update the nonsecret host configuration before restarting the host. A release notification or image publication alone does not perform this deployment. No production routing or activation is changed by this overlay.

Run `bash scripts/testBrowserEgress.sh` to qualify the actual images. The fixture uses synthetic HTTP, TLS and DNS servers in fully isolated Docker networks (including 1.1.1.0/29 with no host bridge address); it never contacts public DNS or the Internet. It tests mixed DNS answers, rebinding, redirects, independent packet filtering, direct-route refusal, dropped runtime capabilities, actual Chromium screenshots/input and automatic retirement after proxy loss. The existing offline image and host-service tests remain required too.
