# Foundation configuration

## Shared theme

The root `tailwind.config.ts` retains the reusable `primary` and `accent` palettes,
loading-dot keyframes and typography plugin from the previous dashboard. The dashboard
stylesheet explicitly loads that typed configuration with Tailwind 4's supported `@config`
directive. A future auth stylesheet should load the same configuration, not maintain a copy.
The theme provides reusable tokens; it does not force the old dashboard's dark-only layout.

Source discovery is scoped to the dashboard and shared UI source, excluding component tests.
The typography plugin provides `prose` utilities when rich text is introduced. No Storybook,
Vite or browser automation plugins are required.

## Prepared PostgreSQL schema tooling

Drizzle ORM and Drizzle Kit are both pinned to the matching official `1.0.0-rc.4`
release candidate, as requested. They are intentionally prerelease dependencies: review
their release notes together when upgrading. This release no longer includes the old
`@esbuild-kit` dependency chain, so no legacy esbuild override is kept.

`apps/auth/drizzle.config.ts` selects PostgreSQL and the auth application's own schema and
migration directory. Paths are resolved relative to that configuration, not the caller's
current directory. The schema entrypoint is intentionally empty until real auth tables are
designed. No placeholder table, database, account or migration is created by setup or startup.

Run from the repository root:

```sh
bun run db:generate:auth
bun run db:check:auth
```

These are schema-generation and migration-consistency commands, not deployment commands.
Generation can write reviewed migration artifacts when the schema changes; it does not connect
to PostgreSQL. The configuration contains no `dbCredentials`, secret loader or fallback URL.
Do not add `push` or automatic migration execution to ordinary development startup.

The chosen runtime adapter is `drizzle-orm/bun-sql`, using Bun's native SQL driver. It will be
initialized only when the auth persistence boundary and scoped Doppler credentials are added.
That connection, database provisioning and actual migration execution are not active yet.
Dashboard persistence will receive a separate schema and migration configuration when needed;
the dashboard must not import or access auth-owned tables directly.

## Native test timings

`bun run test:timings` explicitly refreshes the two native Bun scheduling inventories:
`.bun-test-timings.json` for ordinary unit tests and `.bun-browser-test-timings.json` for
Happy DOM component tests. Review and commit measured changes when useful; CI and normal tests
read existing maps but do not rewrite them. The previous project's file paths and timings are
not reused, and Storybook timing data is not carried forward.

Unit and DOM tests remain separate processes. Each uses Bun's native two-worker scheduler and
default file isolation. Integration tests stay separate. There is no custom batch planner,
required per-file inventory or fixed three-batch framework.
