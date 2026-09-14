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

- `apps/auth/src/security`: accounts, proofs, protected mutations, encrypted email outbox.
- `apps/auth/src/database`: auth-only schema and native Bun SQL/Drizzle persistence.
- `apps/auth/src/oidc`: maintained protocol engine, encrypted durable adapter, central grant binding.
- `apps/auth/src/forwardAuth.ts`: explicit resource policies and short-lived handoff tickets.
- `apps/dashboard/src/authentication.ts`: confidential OIDC client and token-free browser boundary.
- `packages/identity-ui`: shared forms, API validation and automatic step-up coordination.
- `packages/contracts` and `packages/ui`: small browser-safe shared contracts/presentation.

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

Drizzle 1.0.0-rc.4 and Effect 4.0.0-rc.115 are intentional prerelease dependencies.
Review upgrades together with their integration tests, not only the package manager's output.

See [security](identity-security.md) and [operations](identity-operations.md).
