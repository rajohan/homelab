# Homelab

A home infrastructure dashboard, independent Auth service and Mira assistant.
The web app and Windows client share the same React UI and server workflows.

## Develop

Use the Bun package and revision in `.bun-version` and `.bun-revision`:

```sh
bun --no-env-file scripts/installBun.ts "$PWD/.cache/bun"
export PATH="$PWD/.cache/bun/bin:$PATH"
bun install --frozen-lockfile
bun run setup
bun run dev
```

Open `http://localhost:3100`. Sign in as **developer** with
**Development-only-password-123!**. For the temporary authenticator, run
`bun run dev --code`. Docker is needed for one disposable PostgreSQL container.
The command starts the real Auth and Dashboard applications with development
configuration. UI changes use Bun hot reload; restart for server changes.
Ctrl+C stops the processes and removes the temporary database.
No production credentials or data are needed, and there are no mock service APIs.

When developing on Main, forward both application ports:

```sh
ssh -N -L localhost:3100:127.0.0.1:3100 -L localhost:3101:127.0.0.1:3101 main
```

For Impeccable Live, use `bun run dev --live` and the original helper from the
normal Mira build. See [the Live workflow](docs/mira-skills.md#impeccable-live-in-development).

For an already configured development database, `bun run dev:services`
starts Auth and Dashboard with Bun server hot reload. Pass `auth`, `dashboard`,
`mira` or `worker` to select services. Configuration is described in
[identity operations](docs/identity-operations.md).

## Check and build

```sh
bun run check
bun run db:check:auth
bun run db:check:dashboard
bun run build
```

`check` uses the existing formatting, lint and TypeScript rules. There is no
automated test suite or coverage pipeline. Review behavior manually where needed,
particularly when changing authentication, external actions or deployment.

The root `package.json` and `bun.lock` own all JavaScript dependencies. Shared
source directories use TypeScript aliases; they are not separately installed packages.

```text
apps/auth/          Sign-in, OIDC, ForwardAuth, identity API and migrations
apps/dashboard/     Shared web UI, private API, operations and worker
apps/mira/          Assistant execution, integrations and computer/browser access
packages/           Shared UI, contracts, scheduling and notifications
scripts/            Setup, development, checks, build and publication
deploy/            Container definitions and deployment configuration
```

## Release and deployment

PRs run formatting, lint, types, migration metadata checks and application builds.
Release Please manages the version and changelog. The release workflow builds
**Auth**, **Main** and the small **network proxy** once, plus the Windows installer.
Main's Dashboard, worker, Mira, browser and code execution use the same image.
Separate containers keep their existing permissions and configuration.

Release publication does not deploy. Use the existing backup, migration and health
verification procedure. See [releases](docs/releases.md),
[deployment](docs/release-deployment.md) and [dependencies](docs/dependencies.md).

See [contributing](CONTRIBUTING.md), [architecture](docs/architecture.md),
[security](SECURITY.md), [Mira](docs/mira.md), [operations](docs/operations.md)
and [application controls](docs/applications.md).

English code, documentation and UI. Developed with AI assistance. MIT licensed.

Windows package changes also compile the installer on a Windows runner. UI-only
changes skip that workflow; it runs no acceptance or test suite.
