# Dependency updates

GitHub Actions receive weekly Dependabot update PRs. Review and merge them through the normal repository checks.

Bun 1.4.2 writes `bun.lock` with `lockfileVersion: 2`. The first hosted Dependabot run rejected that file because its Bun parser supports versions up to 1. The Bun updater entry is therefore not enabled while that incompatibility exists. Do not downgrade Bun or hand-edit the lockfile to silence the updater.

For application dependencies, run `bun outdated` in this checkout, update the intended packages on a feature branch using Bun, and commit the resulting manifests and lockfile. Keep coupled packages, such as the tRPC client/server or React/type packages, aligned. Run all documented checks before opening a PR.

Automated Bun update PRs can be enabled when the hosted updater supports this lockfile, or when a compatible alternative is deliberately configured. This temporary limitation does not affect installation, builds, CI or production artifacts.

`CHANGELOG.md` is generated and maintained by Release Please. It is excluded from Oxfmt so every generated release PR does not require a separate manual formatting commit. Source, configuration and manually maintained documentation remain checked.

## Evidence

- [Initial hosted Bun updater result](https://github.com/rajohan/homelab/actions/runs/34860291696)
- [Dependabot ecosystem support](https://docs.github.com/en/code-security/dependabot/ecosystems-supported-by-dependabot/supported-ecosystems-and-repositories)
