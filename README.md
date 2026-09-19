# Homelab

A modular home infrastructure dashboard with an independently deployable identity service.

Account security, OIDC, ForwardAuth, background jobs, automation access and infrastructure
monitoring are implemented. New application controls and the notification inbox are developed
independently of production rollout. A PR, successful build or green readiness check is not
approval to change live services, identities or routes.

## Start developing

Use the pinned Bun version in `.bun-version`:

```sh
bun install --frozen-lockfile
bun run setup
bun run dev:identity
```

The identity preview requires Docker for one disposable PostgreSQL 18 container. It binds both
apps and PostgreSQL to loopback, generates independent keys in memory, and seeds only a
synthetic account: **developer / Development-only-password-123!**. Open
`http://localhost:3100`. Development emails appear only in the local terminal, never in Resend.
Use synthetic data only. Ctrl+C closes both apps and removes the exact temporary database;
nothing is imported from production or retained as a second backup.

The preview also serves synthetic Docker/Loki APIs and sample inbox notifications. Application
controls affect only in-memory demo containers, never the Docker daemon hosting the preview.

When developing on Main, forward **both ports with the same numbers**, because OIDC origins
and callbacks must match:

```sh
ssh -N -L localhost:3100:127.0.0.1:3100 -L localhost:3101:127.0.0.1:3101 main
```

Open `http://localhost:3100`, not an IP alias or a different port. This preview is disposable;
restart it after backend changes. For persistent, independently running development processes,
supply isolated configuration and use `bun run dev`, `dev:auth` or `dev:dashboard` (Bun hot reload).
They never automatically migrate or seed a configured database. See [configuration](docs/identity-operations.md).
iPhone/NFC acceptance needs private HTTPS origins reachable by the actual device.

## Implemented account flows

- Password sign-in, TOTP, WebAuthn security keys/passkeys, one-use recovery codes.
- Settings for email verification/change, password changes, factor enrollment/removal,
  recovery codes, session inventory/revocation and security activity.
- A shared security-verification modal: stale-proof actions pause and retry once after
  verification. Cancel, logout, changed sessions and ambiguous network failures do not replay.
- Confidential OIDC code + S256 PKCE, claims, rotating refresh tokens, introspection,
  revocation and confirmed RP-initiated logout.
- Traefik ForwardAuth with explicit host/path policies, a trusted proxy credential and
  host-only resource sessions; public media/API exceptions stay explicit.
- A dashboard BFF: browser JavaScript never receives access or refresh tokens.

[Security design](docs/identity-security.md) documents limitations and trust boundaries.
[Operations and cutover](docs/identity-operations.md) covers recovery, Doppler and production gates.

## Operations workspace

- Infrastructure inventory and resource history from the existing monitoring backend.
- Durable background work, schedule controls, per-run events and narrowly scoped automation tokens.
- [Application controls](docs/applications.md): existing-container and project lifecycle operations,
  bounded safe metadata and allowlisted Loki history. Production control is opt-in.
- [Notifications](docs/notifications.md): durable producer events, personal acknowledgements,
  filters and virtualized history. Existing Alertmanager/Pushover delivery is unchanged.

## Verification

```sh
bun run check
bun run test:coverage
bun run db:check:auth
export HOMELAB_TEST_DATABASE_URL=postgres://...@127.0.0.1:5432/homelab_auth_test
bun run test:integration
bun run build
bun run test:smoke
```

Integration tests require a **disposable** loopback database named exactly `homelab_auth_test`;
they delete synthetic fixture data. Never supply a production database. See [testing](docs/testing.md).
Bun/Happy DOM tests are intentionally used without Playwright, Storybook or Vitest. Physical
authenticators and real browser security behavior still have a manual acceptance checklist.

`oidc-provider` officially targets Node LTS and emits an unsupported-runtime warning on Bun.
The pinned library is tested here on Bun 1.4.2, including actual code exchange, refresh and logout;
this is compatibility evidence, not an upstream support guarantee. Do not suppress the warning.
Re-run the protocol and device gates after runtime/library upgrades.

## Layout

```text
apps/
  auth/             Identity API, OIDC, persistence, migrations and sign-in UI
  dashboard/        Dashboard shell, Settings, OIDC BFF and private tRPC API
packages/
  ui/               Reusable components and shared identity features
  contracts/        Browser-safe shared schemas and types
scripts/            Repository-owned setup, development, build and test commands
deploy/             Independent application images and routing examples
docs/               Architecture, security, configuration and operational boundaries
```

Both applications separate `src/browser/` from `src/server/`. Within `ui`, generic
`components/` do not depend on `features/identity/`; account panels, dialogs, API validation
and verification coordination live in that feature. Each React component has its own file,
enforced by lint. See [architecture](docs/architecture.md) for the folder conventions.

Auth can run on Edge and dashboard on Main. Shared packages compile into each build;
neither app needs the other's source tree or process at runtime. Auth has no Docker socket,
host SSH key, OpenClaw dependency or homelab administration privileges.

Use `bun run start:auth` / `start:dashboard` after building, with scoped runtime environment.
Startup fails closed when production configuration is missing. These commands select the
correct artifact directory and disable automatic `.env` loading. See [deployment](deploy/README.md).

## Project conventions

English code, documentation and UI. Bun for installation, tests, scripts, builds and runtime.
Typed Oxc configuration, strict TypeScript, Tailwind 4, Headless UI, TanStack Form/Query/Router,
Effect server boundaries, Valibot and private tRPC/SuperJSON. Drizzle and Effect remain on the
explicitly requested release candidates.

Read [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md),
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md), [architecture](docs/architecture.md),
[release workflow](docs/releases.md) and [dependency policy](docs/dependencies.md).
Release-please coordinates versioning; image publication runs with the approved release workflow.

Developed with AI assistance, retaining selected conventions and security-flow behavior from
[Mira-Dashboard](https://github.com/rajohan/Mira-Dashboard), without importing production
credentials or identity data. Licensed under [MIT](LICENSE).
