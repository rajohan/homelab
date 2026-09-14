# Deployment boundaries

These definitions build and run the foundation applications independently. They do not replace
Authelia, change DNS/Traefik, create databases, fetch production credentials or expose WAN ports.

## Local container verification

Run from the repository root:

```sh
docker compose -f deploy/compose.yaml build
docker compose -f deploy/compose.yaml up -d
docker compose -f deploy/compose.yaml ps
docker compose -f deploy/compose.yaml down
```

Dashboard is mapped to `127.0.0.1:3110`; auth is mapped to `127.0.0.1:3111`.
These differ from the development ports. Containers run as the image's unprivileged Bun user,
with a read-only filesystem, dropped capabilities and no application secrets or host mounts.

Each service is independently selectable. For example, `up -d --no-deps dashboard` does not
restart auth. This local Compose file is a verification topology, not a multi-host orchestrator.

## Later deployment to Main and Edge

For a local production-mode run after building, use either `bun run start:dashboard` or
`bun run start:auth` from the repository root. These run the built application with its `dist`
directory as the working directory, disable automatic environment-file loading and retain the
loopback listener default. Stop the command when finished; do not run it on a development
listener's occupied port.

Keep `server.js` and every generated asset from that application's `dist` directory together.
Bun's built HTML asset references resolve relative to the runtime working directory. Do not
start `bun apps/dashboard/dist/server.js` from the repository root. The Docker image already
copies the complete artifact to `/app` and sets `/app` as its working directory; the built-runtime
smoke check uses the same layout.

Build/tag each image from a reviewed commit. Deploy the dashboard image on Main and the auth
image on Edge through separate deployment invocations. Copying the entire repository, installing
development packages or mounting Main's source tree on Edge is not required at runtime.

Private HTTPS routing, scoped runtime secrets, monitoring targets and approved authentication
policies must be completed before a production identity service is enabled. Keep deployment
overrides nonsecret and versioned. Preserve the existing wildcard certificate lifecycle.

Health checks report process readiness only. A foundation auth image must never be configured
as Traefik's authorization provider; its authorization routes deliberately fail closed.
