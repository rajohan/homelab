# Shared configuration and migrations

## Shared theme and tooling

The typed root `tailwind.config.ts` retains reusable primary/accent palettes, loading-dot
keyframes and typography. Both apps load it through Tailwind 4's `@config` directive. Their
source discovery includes shared UI and identity UI, excluding test files. The shared `cn`
helper combines clsx and tailwind-merge. There is no second CSS reset framework.

Oxc configuration remains in `oxlint.config.ts` / `oxfmt.config.ts`. Browser, server and
Happy DOM test types are checked separately. Boundary rules prevent server internals leaking
into browser/shared packages. Only the disposable integration-style development harness may
compose both app entrypoints; production apps remain independent.

## PostgreSQL

Drizzle ORM and Kit are pinned together to `1.0.0-rc.4`. Schema and reviewed migration artifacts
belong to auth. Schema generation does not connect to a database:

```sh
bun run db:generate:auth
bun run db:check:auth
```

Applying migrations is an explicit operator command, never a web-startup side effect:

```sh
bun run auth:admin migrate
```

It requires auth's scoped environment. Use only an isolated database during development.
Native Bun SQL prepared statements remain enabled: disabling preparation with this RC failed
JSONB serialization in integration testing. Production connections require verified TLS and
either direct PostgreSQL or a separately qualified PgBouncer configuration. See
[operations](identity-operations.md).

## Native test timings

`bun run test:timings` refreshes `.bun-test-timings.json` and
`.bun-browser-test-timings.json`. Review measured changes when useful. CI reads existing maps
but never regenerates them. Bun unit tests and Happy DOM tests remain separate two-worker
processes; real HTTP/database integration tests run separately without DOM emulation.
