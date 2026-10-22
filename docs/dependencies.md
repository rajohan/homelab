# Dependency updates

Dependabot keeps the update conventions from Mira-Dashboard: weekly Monday checks in `Europe/Oslo`, dependency labels, scoped Conventional Commit prefixes, and separate groups for major and minor/patch updates. Grouping reduces PR noise; it does not enable automatic merging. Review and merge updates through the normal repository checks.

GitHub Actions are checked at 06:30, with at most four open version-update PRs, the `type: dependencies` and `area: ci` labels, and the `ci(deps)` prefix.

Bun application updates are checked at 06:00, with up to five open version-update PRs, the `type: dependencies` label and the `chore(deps)` prefix. Version updates are enabled again: GitHub announced hosted Bun 1.4 support on 2026-10-20, and Dependabot's merged parser/updater change supports text lockfile versions 2 and 3. This repository uses pinned Bun 1.4.3 and retains `bun.lock` version 2. Do not downgrade the lockfile or switch package managers.

Dependabot version updates, security updates and alerts remain separate features. Continue running `bun audit` and reviewing security findings. The first hosted Bun update after this configuration reaches the default branch must preserve lockfile version 2, install with the pinned Bun version and pass CI.

For application dependencies, run `bun outdated --recursive` in this checkout so all workspaces are included. Preview a full update with `bun update --recursive --latest --exact --ignore-scripts --dry-run`, then remove `--dry-run` to update the manifests and lockfile on a feature branch. Inspect prerelease channels separately: `--latest` intentionally does not downgrade an installed release candidate to an older stable release. Keep coupled packages, such as the tRPC client/server or React/type packages, aligned. Verify `bun install --frozen-lockfile --ignore-scripts`, run `bun audit` and all documented checks before opening a PR.

Dependabot reads its configuration from the default branch, so re-enabling version updates takes effect after this change is merged. The weekly schedules, labels, Conventional Commit prefixes and separate major/minor groups are unchanged.

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
