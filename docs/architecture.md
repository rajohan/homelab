# Architecture

## Independent applications, shared repository

Auth and dashboard are separate applications with separate listeners and deployment lifecycles.
Shared UI and schema packages are compiled into each consuming build; there is no shared
network filesystem dependency. The source checkout lives on Main, not on every runtime host.

The intended deployment is dashboard on Main and auth on Edge. This isolates application
restarts, not failure of their common PVE host or database infrastructure.

Keep feature modules inside the owning application. Add a shared package only when multiple
consumers actually need the same interface. Do not import another application's server internals
or let optional integrations become prerequisites for startup.

## Technology ownership

- Bun: package installation, scripts, application runtime, bundling and tests.
- React, Tailwind and shared UI: presentation.
- TanStack Router and Query: navigation and remote state. TanStack Form is planned for the first real forms, not installed solely as an unused foundation dependency.
- tRPC with SuperJSON: the private dashboard API; Valibot validates public contracts.
- Effect: server-side service composition and bounded workflows, not ordinary UI state.
- PostgreSQL/Drizzle: schema tooling is prepared for auth; the runtime connection and durable state will be introduced with actual stateful features.

OIDC endpoints and JWTs must use their standard encodings, not SuperJSON. A protocol engine
and its runtime compatibility will be qualified separately. No OIDC library is selected or
silently represented as operational by this scaffold.

## Authentication milestone

Auth currently reports `authenticationImplemented: false` and rejects unknown/authentication
routes. Its health endpoints only describe the foundation service. Dashboard's status endpoint
reports that Authelia remains the existing external authority; it does not claim the preview
itself has authentication enabled.

The eventual dashboard will be an OIDC client, not a second password authority. Auth must run
without OpenClaw, dashboard integrations, Docker access or homelab administrator SSH keys.

Before replacing Authelia, qualify the existing OIDC clients, trusted identity headers, public
media route exceptions, account linking, recovery and physical YubiKey/iPhone NFC behavior.
Keep the intended production issuer stable and maintain a tested rollback. There is no automatic
cutover as part of building or starting this repository.

## Data and secrets

The foundation requires no database or secrets. Future development state must be isolated from
production even though both can use the existing database server. Use scoped credentials and
explicit migrations; never automatically synchronize a production schema during web startup.

Use existing Doppler references, certificates, PBS backup, VictoriaMetrics, Loki and alerting
systems when integrating the applications. Do not introduce parallel backup or secret-management
systems. Keep credentials out of Git, browser bundles, Docker layers and diagnostic output.

## Test boundaries

Use small Bun unit/component tests and separate HTTP/database integration suites. Happy DOM
tests UI behavior, but does not prove real browser cookie enforcement, rendering or physical
authenticator behavior. Real browser/device acceptance remains a targeted manual milestone gate.
There is no Playwright, Storybook or substitute browser automation framework in this foundation.
