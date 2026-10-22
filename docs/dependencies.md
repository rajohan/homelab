# Dependency updates

Dependabot keeps the update conventions from Mira-Dashboard: weekly Monday checks in `Europe/Oslo`, dependency labels, scoped Conventional Commit prefixes, and separate groups for major and minor/patch updates. Grouping reduces PR noise; it does not enable automatic merging. Review and merge updates through the normal repository checks.

GitHub Actions are checked at 06:30, with at most four open version-update PRs, the `type: dependencies` and `area: ci` labels, and the `ci(deps)` prefix.

Bun application updates are checked at 06:00, with up to five open version-update PRs, the `type: dependencies` label and the `chore(deps)` prefix. Version updates are enabled again: GitHub announced hosted Bun 1.4 support on 2026-10-20, and Dependabot's merged parser/updater change supports text lockfile versions 2 and 3. This repository uses pinned Bun 1.4.4 and retains `bun.lock` version 2. Do not downgrade the lockfile or switch package managers. Runtime pins cover `.bun-version`, `packageManager`, `engines`, both Docker stages and the transitive Bun peer in the lockfile. `@types/bun` remains on the latest published 1.4.3: its 1.4.4 package is not yet published as of 2026-10-22. Do not override its exact `bun-types` dependency to manufacture a matching version; type checks and runtime tests qualify the combination.

Dependabot version updates, security updates and alerts remain separate features. Continue running `bun audit` and reviewing security findings. The first hosted Bun update after this configuration reaches the default branch must preserve lockfile version 2, install with the pinned Bun version and pass CI.

For application dependencies, run `bun outdated --recursive` in this checkout so all workspaces are included. Preview a full update with `bun update --recursive --latest --exact --ignore-scripts --dry-run`, then remove `--dry-run` to update the manifests and lockfile on a feature branch. Inspect prerelease channels separately: `--latest` intentionally does not downgrade an installed release candidate to an older stable release. Keep coupled packages, such as the tRPC client/server or React/type packages, aligned. Verify `bun install --frozen-lockfile --ignore-scripts`, run `bun audit` and all documented checks before opening a PR.

Dependabot reads its configuration from the default branch, so re-enabling version updates takes effect after this change is merged. The weekly schedules, labels and separate major/minor groups are unchanged. Bun application/build dependency updates keep `chore(deps)`. Release Please includes exactly that type and scope in the Dependencies changelog section, so their squash merges propose a patch release. Ordinary `chore` commits remain hidden and do not trigger a release alone. GitHub Actions retain `ci(deps)` and do not trigger a release by themselves.

`CHANGELOG.md` is generated and maintained by Release Please. It is excluded from Oxfmt so every generated release PR does not require a separate manual formatting commit. Source, configuration and manually maintained documentation remain checked.

## Evidence

- [Initial hosted Bun updater result](https://github.com/rajohan/homelab/actions/runs/34860291696)
- [Dependabot ecosystem support](https://docs.github.com/en/code-security/dependabot/ecosystems-supported-by-dependabot/supported-ecosystems-and-repositories)
- [Hosted Bun 1.4 support announcement](https://github.blog/changelog/2026-10-20-dependabot-now-supports-npm-12-pnpm-11-and-12-and-bun-1-4/)
- [Merged Bun lockfile-v2/v3 support](https://github.com/dependabot/dependabot-core/pull/16485)
- [Updater Bun version](https://github.com/dependabot/dependabot-core/blob/main/bun/Dockerfile)
- [Pausing version updates does not disable security updates](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference#open-pull-requests-limit)

## Current audit follow-up

The root override pins `postcss-selector-parser` to 7.1.7 while
`@tailwindcss/typography` still requests vulnerable 6.0.10. This addresses
[GHSA-rj75-hqrm-r3gf](https://github.com/advisories/GHSA-rj75-hqrm-r3gf);
remove the override when typography accepts a fixed parser. The build and smoke
checks qualify the override against our actual typography stylesheet.

`braces@3.0.3` remains a transitive development dependency of
`lcov-result-merger > fast-glob > micromatch`.
[GHSA-vfj7-8cjw-p6xm](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm)
has no patched version as of 2026-10-22. Its consumer here is CI coverage merging
with repository-defined patterns, not an application request path. Keep the
audit finding visible and update the coverage dependency when an upstream fix
is available; no local package patch or audit suppression is used.

## Prerelease channels

Audit packages already on alpha, beta or RC channels separately from `latest`. Compare the maintained upstream channel, release notes and publication dates; a commit-suffixed prerelease can sort above a newer official RC in SemVer. Do not move stable dependencies onto experimental channels just to maximize version numbers.

Drizzle ORM and Kit are kept together at the official `1.0.0-rc.5` release published on 2026-10-21, replacing the older `1.0.0-rc.5-5935859` development build. Its `latest` npm tag still points to the older 0.x stable line, so updating only `latest` misses this RC. Validate both migration metadata and isolated database integration tests when changing these pins. The RC5 upgrade uses the official `drizzle-kit up` conversion for the six checked-in snapshots; existing SQL migrations are unchanged, and schema generation reports no new migrations.

- [Official Drizzle RC5 release](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-rc.5)
