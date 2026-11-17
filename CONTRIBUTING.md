# Contributing to Homelab

Follow [AGENTS.md](AGENTS.md) and the [README](README.md) setup. Code, comments,
documentation and UI are English. Use the pinned Bun runtime and root lockfile.

## Keep it small

- Reuse the real app, shared UI and existing workflows. Do not create a second demo app.
- Keep dependencies in the root manifest. Source folders do not need their own manifests.
- Auth remains independently deployable on Edge. Main services share one built image.
- Use the existing Chat approval controls instead of adding another draft workspace.
- Keep shared UI/contracts browser-safe, and preserve existing formatting and lint rules.
- Use synthetic development data; never commit credentials or production records.

Exported functions and public methods need meaningful JSDoc. TypeScript owns types;
document behavior, parameters and return semantics. Each React component has its
own file. Effect, Valibot and private tRPC/SuperJSON retain their existing roles.

## Verify

```sh
bun run check
bun run db:check:auth
bun run db:check:dashboard
bun run build
```

There is deliberately no automated test suite. Run relevant manual checks for the
changed behavior and state what was actually verified. Do not add test frameworks,
coverage jobs or repeated full verification runs to a small change.

## Review and release

Use a focused branch and a Conventional Commit PR title. Describe the behavior,
validation and relevant rollout implications. Resolve CI and review findings;
never bypass branch protection. CodeQL runs on pull requests and pushes to `main`, weekly, and on manual dispatch.

Release Please owns version/changelog changes. The release workflow builds the
publishable artifacts directly, without rerunning PR checks or transferring large
images through workflow artifacts. Publication is separate from deployment.
See [releases](docs/releases.md) and [deployment](docs/release-deployment.md).

Windows package changes also compile the installer on a Windows runner. UI-only
changes skip that workflow; it runs no acceptance or test suite.
