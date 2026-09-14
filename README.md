# Homelab

A modular home infrastructure dashboard with an independently deployable identity service.

**Current milestone: foundation only.** The dashboard has a working shell and typed status API.
The auth application is a fail-closed placeholder, not an identity provider. Existing Authelia
authentication remains unchanged. There are no production integrations or stored credentials.

## Start developing

Use the Bun version in `.bun-version`, then run from this repository:

```sh
bun install --frozen-lockfile
bun run setup
bun run dev
```

Open `http://127.0.0.1:3100` for the dashboard. Auth's informational endpoint is
`http://127.0.0.1:3101`. Both bind to loopback by default. No database, Doppler login, OpenClaw,
Docker daemon or production secrets are required to develop this milestone.

When developing on Main, keep the server private and forward the port from your computer:

```sh
ssh -N -L 13100:127.0.0.1:3100 main
```

Then open `http://127.0.0.1:13100` locally. Stop the SSH command when finished. An approved
private HTTPS development origin is needed before testing real WebAuthn/OIDC; it is not
provisioned by `setup` or by this foundation.

## Daily commands

```sh
bun run check
bun run test
bun run test:integration
bun run build
bun run test:smoke
```

The check command covers formatting, lint and TypeScript. Unit/component tests use Bun,
Happy DOM and Testing Library. Integration tests exercise real HTTP handlers without contacting
production services. Playwright, Storybook and Vitest are intentionally absent.

Run `bun run test:coverage` for native Bun LCOV reports. CI uploads the separate unit and
component reports together to Codecov; see [testing and coverage](docs/testing.md).
After building, the smoke check starts both built applications briefly on independent ephemeral
loopback ports. It verifies the dashboard document, JavaScript/CSS assets, deep links, status API
and auth's fail-closed protocol responses, then stops both processes. It creates no files and
does not contact production services or inherit application secrets.

To run one built application manually, use `bun run start:dashboard` or `bun run start:auth`.
These commands select the correct artifact working directory; do not launch a built dashboard
entrypoint from the repository root directly. See [deployment](deploy/README.md).

## Layout

```text
apps/
  auth/          Independent foundation service; identity implementation comes next
  dashboard/     React shell, tRPC API and server-side Effect services
packages/
  ui/            Small shared presentation components
  contracts/     Browser-safe schemas and types
scripts/         Small, repository-owned development/build/check commands
deploy/          Separate container deployment definitions
docs/            Development, architecture and operational boundaries
```

One repository does not mean one running process. Dashboard builds run on Main; auth builds
can run on Edge. Neither service reads the other's source directory at runtime. Updating the
dashboard must not restart auth. See [architecture](docs/architecture.md) and
[deployment](deploy/README.md).

## Security boundaries

- No login, account, password, OIDC token or ForwardAuth grant is implemented in this milestone.
- A green health endpoint means the foundation process is ready, not that identity is ready.
- Existing Authelia remains authoritative until a separately approved migration.
- Do not expose development listeners, put secrets in browser code, or use production auth data
  for tests. The nonsecret `.env.example` documents listener settings only.
- New runtime secrets will use scoped Doppler access and `HOMELAB_AUTH_*` or
  `HOMELAB_DASHBOARD_*` names. GitHub credentials belong to tooling, never to these applications.

## Contributing

All code, documentation and application text are English. Use a feature branch and a pull
request, keep checks green, and deploy a tested build deliberately. `setup` does not deploy,
alter host configuration or initialize a parent directory as a Git repository.

Use the issue templates for bugs, feature tasks and operational changes. Follow the
[release workflow](docs/releases.md) for Conventional Commits and reviewed releases.
CodeQL scans JavaScript/TypeScript separately from the fast development checks, on pull
requests, changes to `main` and a weekly schedule. No application build or production
credentials are needed for that scan.

The initial foundation was developed with AI assistance. Its selected technology conventions
originate from [Mira-Dashboard](https://github.com/rajohan/Mira-Dashboard), without importing its
old operational integrations or production data. Licensed under [MIT](LICENSE).

Dependency-update behavior and the current hosted Bun updater limitation are documented in [docs/dependencies.md](docs/dependencies.md).
