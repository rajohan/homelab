# Contributing to Homelab

Read [AGENTS.md](AGENTS.md), the [architecture](docs/architecture.md), the [Code of Conduct](CODE_OF_CONDUCT.md), and the [security policy](SECURITY.md) before making changes. All code, comments, documentation, and application text must be in English.

## Local setup

Use the exact Bun version in `.bun-version` and work inside this repository:

```sh
bun install --frozen-lockfile
bun run setup
bun run dev
```

The dashboard listens on `http://127.0.0.1:3100`; the independent auth foundation listens on `http://127.0.0.1:3101`. This milestone needs no production secrets, database, Docker daemon, Doppler login, or OpenClaw process. See the [README](README.md) for private SSH port forwarding when developing on a remote host.

Setup installs repository Git hooks; it does not configure the host, deploy an application, or turn a parent workspace folder into a Git repository. Install and update dependencies with Bun, and commit `bun.lock` with dependency changes. Do not add another package manager or a parallel build framework.

## Development boundaries

- Keep auth and dashboard independently buildable and deployable. Dashboard work must not require restarting auth.
- Keep `packages/ui` and `packages/contracts` browser-safe. Do not import server-only code into them.
- Use Effect for server workflows, Valibot for validation, and SuperJSON for the private tRPC API. Protocol responses such as OIDC/JWT are not SuperJSON payloads.
- Add small modules within the relevant application before introducing another shared package or service.
- Use synthetic data. Do not copy credentials, production identity records, or runtime data into the repository.
- Do not make the foundation grant authentication or authorization merely to make a test pass. Authelia remains authoritative until a separately approved migration.

## Verify a change

```sh
bun run check
bun run test
bun run test:integration
bun run build
bun run test:smoke
```

`check` runs formatting, lint, and TypeScript checks. Use `bun run test:coverage` in place of `bun run test` when checking the unit/component coverage report; CI does this without repeating the same tests.

Name unit tests `*.test.ts`, component tests `*.test.tsx`, and real HTTP integration tests `*.integration.test.ts`. Use the repository test scripts so Happy DOM stays isolated from native networking tests. Do not add Vitest, Playwright, or Storybook.

A bug fix should include a focused regression test and relevant failure cases. Keep tests deterministic and independent of live homelab services. UI checks in Happy DOM do not replace targeted manual browser and authenticator acceptance tests when identity features are implemented.

See [testing and coverage](docs/testing.md) for report locations and limitations. After building, the smoke check starts both built services on temporary loopback ports and verifies their behavior without deploying them.

## Pull requests and review

Use a focused feature branch, the issue forms when helpful, and the pull request template. State what changed, why, the checks you ran, and any remaining risks. Disclose material AI assistance and verify its output; generated code is held to the same review standards as other code.

PR titles follow `type(scope): description`, for example `feat(dashboard): add service inventory` or `fix(auth): reject an invalid return URL`. Supported types are `build`, `chore`, `ci`, `docs`, `feat`, `fix`, `perf`, `refactor`, `revert`, and `test`. Use a descriptive scope such as `auth`, `dashboard`, `ui`, or `ci`. Mark breaking changes with `!` and explain them in the PR.

The `conventional-pr-title` check reads PR metadata only. It uses the workflow from the default branch, so adding or changing that workflow in a PR does not activate the new version until it is merged. The ordinary `verify` job checks code and builds; CodeQL performs a separate scan. Resolve failures instead of bypassing hooks or checks.

Codecov's upload step and its GitHub status notifications are separate integrations. A successful upload is not proof that Codecov has permission to post checks. See [testing and coverage](docs/testing.md) for setup and troubleshooting.

## Releases and deployments

Use reviewed squash merges with a Conventional Commit title. Release Please proposes version and changelog changes in a separate PR. Follow the [release workflow](docs/releases.md); do not manually rewrite release bookkeeping or reuse published tags.

A release is not a deployment. Auth and dashboard are deployed separately using the [deployment instructions](deploy/README.md). Changes to production authentication, data, network access, or secrets require their own explicit review and authorization.

Document migration and rollback steps when a change affects existing deployments. Never include real credentials or private production details in an issue, PR, or test artifact.
