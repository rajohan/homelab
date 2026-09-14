# Independent deployment

The definitions build auth and dashboard separately. They **do not** replace Authelia, modify
DNS/Traefik, provision a database, fetch credentials or expose WAN ports.

```sh
docker compose -f deploy/compose.yaml build auth
docker compose -f deploy/compose.yaml build dashboard
```

Supply only the selected app's scoped environment and use
`docker compose -f deploy/compose.yaml up -d --no-deps auth` (or `dashboard`).
Unprovided variables remain absent; runtime validation fails closed. Do not print
`docker compose config` with real secrets or store its expanded output in Git.

This Compose file is a single-host verification definition, not a multi-host orchestrator.
Dashboard maps to loopback 3110 and auth to loopback 3111. Both run as Bun's unprivileged user,
with read-only root filesystems, dropped capabilities, bounded logs and no source/host mounts.
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
