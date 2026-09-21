# Dependency updates

Dependabot keeps the update conventions from Mira-Dashboard: weekly Monday checks in `Europe/Oslo`, dependency labels, scoped Conventional Commit prefixes, and separate groups for major and minor/patch updates. Grouping reduces PR noise; it does not enable automatic merging. Review and merge updates through the normal repository checks.

GitHub Actions are checked at 06:30, with at most four open version-update PRs, the `type: dependencies` and `area: ci` labels, and the `ci(deps)` prefix.

Bun's application-update settings are retained for 06:00, with the `type: dependencies` label and `chore(deps)` prefix. Version-update PRs are temporarily paused with `open-pull-requests-limit: 0`. Bun 1.4.2 writes `bun.lock` with `lockfileVersion: 2`, but the first hosted updater run rejected it because its parser supports versions only up to 1. Rechecked on 2026-09-21: the upstream updater still bundles Bun 1.3.14, and its lockfile-v2/v3 support PR is not merged. The earlier silent-downgrade fix rejects the new formats; it does not add support for them. Do not downgrade Bun, hand-edit the lockfile, or switch package managers to silence the updater.

The zero limit pauses version updates only; it does not disable Dependabot security updates or alerts. It also does not fix the parser used by security-update jobs, so automated Bun security PRs must not be assumed to work yet. Continue reviewing alerts and running `bun audit`.

For application dependencies, run `bun outdated --recursive` in this checkout so all workspaces are included. Preview a full update with `bun update --recursive --latest --exact --ignore-scripts --dry-run`, then remove `--dry-run` to update the manifests and lockfile on a feature branch. Inspect prerelease channels separately: `--latest` intentionally does not downgrade an installed release candidate to an older stable release. Keep coupled packages, such as the tRPC client/server or React/type packages, aligned. Verify `bun install --frozen-lockfile --ignore-scripts`, run `bun audit` and all documented checks before opening a PR.

Once the hosted updater supports this lockfile, change the Bun entry's limit from `0` to `5` and verify its first update PR preserves lockfile version 2, installs with the pinned Bun version and passes CI. The schedule, labels, prefixes and groups are already prepared. This temporary limitation does not affect installation, builds, CI or production artifacts. Dependabot reads this configuration from the default branch, so changes take effect after merge.

`CHANGELOG.md` is generated and maintained by Release Please. It is excluded from Oxfmt so every generated release PR does not require a separate manual formatting commit. Source, configuration and manually maintained documentation remain checked.

## Evidence

- [Initial hosted Bun updater result](https://github.com/rajohan/homelab/actions/runs/34860291696)
- [Dependabot ecosystem support](https://docs.github.com/en/code-security/dependabot/ecosystems-supported-by-dependabot/supported-ecosystems-and-repositories)
- [Upstream Bun lockfile-v2/v3 support PR](https://github.com/dependabot/dependabot-core/pull/16071)
- [Updater Bun version](https://github.com/dependabot/dependabot-core/blob/main/bun/Dockerfile)
- [Pausing version updates does not disable security updates](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#open-pull-requests-limit)
