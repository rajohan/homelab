# Architecture

## Independent applications

Auth and dashboard have separate listeners, builds, runtime secrets and deployment lifecycles.
Source lives in one repository on Main. Shared browser packages compile into each application's
artifact; there is no shared filesystem dependency in production. Restarting dashboard must not
restart auth. Edge and Main still share the PVE/database failure domain; separation is not HA.

The dashboard is an OIDC client with a backend-for-frontend (BFF), not a second password
authority. Settings calls same-origin BFF endpoints. Auth validates every action against its
central session, using the dashboard's narrowly scoped opaque access token. Sign-in is served
by auth. Both approved UI origins can perform WebAuthn ceremonies under one explicitly chosen
RP ID; arbitrary sibling origins are not accepted.

## Ownership

- `apps/auth/src/server/security`: accounts, proofs, protected mutations, encrypted email outbox.
- `apps/auth/src/server/database`: auth-only schema and native Bun SQL/Drizzle persistence.
- `apps/auth/src/server/oidc`: maintained protocol engine, encrypted durable adapter, central grant binding.
- `apps/auth/src/server/http/forwardAuth.ts`: explicit resource policies and short-lived handoff tickets.
- `apps/dashboard/src/server/identity/authentication.ts`: confidential OIDC client and token-free browser boundary.
- `packages/ui/src/components`: reusable presentation, forms, fields, dialogs and status primitives.
- `packages/ui/src/features/identity`: account panels/dialogs, API schemas and verification coordination.
- `packages/contracts`: browser-safe, environment-neutral shared contracts.

Effect wraps the auth request workflow and dashboard system service. Valibot validates public
input. SuperJSON belongs only to private tRPC; OAuth/JWT responses use standard encodings.
Cryptography, WebAuthn and OIDC protocol handling use maintained implementations, not custom
token formats masquerading as a protocol standard.

PostgreSQL owns all durable auth state, rate limits and one-use operations. There is no separate
Valkey dependency to reconcile for identity. Account-level row locks serialize security changes;
token consumption and revocation are transactional. Dashboard stores no identity tables and
never imports auth persistence.

## UI and behavior

React, Tailwind, Headless UI and TanStack Form/Query/Router provide the shell, keyboard-friendly
forms and dialogs. A shared coordinator resumes only explicitly rejected stale-proof actions.
It binds replay to the current user/session, keeps original form input, and cancels on unmount,
logout, user change or cancellation. It never retries an ambiguous network outcome.

Generic UI never imports identity features or app internals. Apps import presentation from
`@homelab/ui` and account behavior from `@homelab/ui/identity`; this is one package with explicit
entry points, not two overlapping UI packages. The shared `PasswordForm` owns confirmation
validation; the generic `FieldsForm` accepts validation without knowing about passwords.

Each React component lives in its own named file; `react/no-multi-comp` enforces this. Related
components sit together in `layout/`, `pages/`, `components/panels/` or `components/dialogs/`.
Hooks and API clients are separate from presentation. Server modules are grouped into
`config/`, `http/`, `security/`, `database/` and `oidc/`, with tests beside the appropriate layer.

Infrastructure screens remain clearly marked as unconnected. This milestone does not invent
monitoring data or give the dashboard administrative host access.

## Runtime qualification

Bun 1.4.2 runs both apps and the OIDC library's private Node-HTTP-compatible listener. That
listener binds an ephemeral loopback port and is never directly exposed. The public Bun
listener bounds request size and normalizes proxy metadata before reaching the protocol engine.

The OIDC library officially supports Node LTS, not Bun. Real HTTP/database tests and built
smoke tests qualify the pinned combination locally; they do not extend upstream support.
Bun syntax/identifier minification is disabled for the runtime bundle: the OIDC library uses
class names for TTL/model lookup, and syntax folding broke the built token endpoint. Whitespace
minification remains enabled. A configured built-runtime OIDC smoke test prevents regression.

Drizzle ORM/Kit 1.0.0-rc.5-5935859 and Effect 4.0.0-rc.115 are intentional prerelease dependencies.
Review upgrades together with their integration tests, not only the package manager's output.

See [security](identity-security.md) and [operations](identity-operations.md).
