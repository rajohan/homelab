# Dependency updates

Dependabot keeps the update conventions from Mira-Dashboard: weekly Monday checks in `Europe/Oslo`, dependency labels, scoped Conventional Commit prefixes, and separate groups for major and minor/patch updates. Grouping reduces PR noise; it does not enable automatic merging. Review and merge updates through the normal repository checks.

GitHub Actions are checked at 06:30, with at most four open version-update PRs, the `type: dependencies` and `area: ci` labels, and the `ci(deps)` prefix.

Bun application updates are checked at 06:00, with up to five open version-update PRs, the `type: dependencies` label and the `chore(deps)` prefix. Version updates are enabled again: GitHub announced hosted Bun 1.4 support on 2026-10-20, and Dependabot's merged parser/updater change supports text lockfile versions 2 and 3. The repository uses stable Bun 1.4.5 and lockfile version 2. The native installer and runtime checks verify the exact revision in `.bun-revision`. The published Bun types are pinned separately.

CI and Docker bootstrap the same stable version. Update both pin files, `packageManager`, and the sandbox profile together, qualify both operating systems, and publish a new check image before changing the Main/Daytona image binding. The new harness refuses older snapshots. Daytona's policy fingerprint includes the exact runtime revision and requires fresh operator qualification; older policy fingerprints remain valid only for observing and cleaning up existing attempts.

The separate `oxfmt`, `oxlint` and `oxlint-tsgolint` engines and the unused preset package have been removed. Stable Bun supplies formatting. Stable 1.4.5 does not include the lint command, so `bun run lint` resolves the pinned development-only Canary package and checks revision `4ce14ba8b150c3c7315284f3df8480eb4158b38a` before running the existing type-aware lint policy in `bunfig.toml`. The reviewed preset rules are now explicit in that file; the existing `oxlint-tailwindcss` and ESLint JSDoc/React plugins remain pinned. JSDoc parameter selectors preserve the previous native rule's typed-function exemptions. The resolved native lint policy and intentional diagnostics were compared with the original setup. Formatting preserves the existing printing style and Tailwind ordering while adopting Bun's named-import sorting and import merging, as approved for this migration.

Dependabot version updates, security updates and alerts remain separate features. Continue running `bun audit` and reviewing security findings. The first hosted Bun update after this configuration reaches the default branch must preserve lockfile version 2, install with the pinned Bun version and pass CI.

For application dependencies, run `bun outdated` in this checkout against the single root manifest. Preview a full update with `bun update --latest --exact --ignore-scripts --dry-run`, then remove `--dry-run` to update the manifests and lockfile on a feature branch. Inspect prerelease channels separately: `--latest` intentionally does not downgrade an installed release candidate to an older stable release. Keep coupled packages, such as the tRPC client/server or React/type packages, aligned. Verify `bun install --frozen-lockfile --ignore-scripts`, run `bun audit` and all documented checks before opening a PR.

Dependabot reads its configuration from the default branch, so re-enabling version updates takes effect after this change is merged. The weekly schedules, labels and separate major/minor groups are unchanged. Bun application/build dependency updates keep `chore(deps)`. Release Please includes exactly that type and scope in the Dependencies changelog section, so their squash merges propose a patch release. Ordinary `chore` commits remain hidden and do not trigger a release alone. GitHub Actions retain `ci(deps)` and do not trigger a release by themselves.

`CHANGELOG.md` is generated and maintained by Release Please. It is excluded from formatting so every generated release PR does not require a separate manual formatting commit. Source, configuration and manually maintained documentation remain checked.

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
remove the override when typography accepts a fixed parser. The application build checks the override against our actual typography stylesheet.

## Prerelease channels

Audit packages already on alpha, beta or RC channels separately from `latest`. Compare the maintained upstream channel, release notes and publication dates; a commit-suffixed prerelease can sort above a newer official RC in SemVer. Do not move stable dependencies onto experimental channels just to maximize version numbers.

Drizzle ORM and Kit are kept together at the official `1.0.0-rc.5` release published on 2026-10-21, replacing the older `1.0.0-rc.5-5935859` development build. Its `latest` npm tag still points to the older 0.x stable line, so updating only `latest` misses this RC. Validate migration metadata and review migration behavior when changing these pins. The RC5 upgrade uses the official `drizzle-kit up` conversion for the six checked-in snapshots; existing SQL migrations are unchanged, and schema generation reports no new migrations.

- [Official Drizzle RC5 release](https://github.com/drizzle-team/drizzle-orm/releases/tag/v1.0.0-rc.5)

## Native and system dependencies

The browser uses `puppeteer-core` and `@novnc/novnc` from the root manifest and lockfile; Dependabot covers their versions and the noVNC type declarations. Windows input retains `@trycua/cua-driver` and its platform libraries. There is no separate browser CLI download or unmanaged installer.
Chromium, x11vnc, Xvfb/Openbox, xdotool, scrot, xclip and Python come from Debian packages in the Main Dockerfile. The existing release job refreshes that package layer using `PACKAGES_WEEK`; the weekly cache key takes effect when a release is built, rather than scheduling an independent deployment. Dependabot monitors both
application and proxy base images. Installed images update through Homelab releases.
Windows build-tool pins are centralized in `package.json` under `config.windows`,
including their checksum, publisher and official update feed. Skill source versions,
revisions and source paths live under `config.skills`. The updater checks all these
entries and the root `packageManager` stable Bun channel every hour; no manual search
for new upstream releases is required. Dependabot continues to own npm dependencies,
GitHub Actions and both Dockerfiles. The installed companion
continues to use the standard Homelab release updater; no locally installed helper is introduced.

## Source dependency checks

The existing worker scheduler runs `homelab.dependencies` hourly alongside release
checks. Updates shows each manifest pin, upstream version, freshness and unavailable
feeds. The read-only Check updates action uses the same job and permissions. An
individual feed failure stays unknown without hiding successful checks or blocking
Homelab release verification. The snapshot is bound to the exact manifest, so a new
release or rollback cannot show another version's pins as current.

Impeccable and Intent use their official stable GitHub releases. Inno Setup uses its
official GitHub release tags; WebView2 uses the stable NuGet SDK feed. Bun follows
the stable npm channel and requires matching Linux/Windows package versions.
All reads
are bounded, and GitHub uses the existing release credential/cache/backoff.

New source entries in `config.windows` or `config.skills` must include a supported
official update feed; the offline repository check validates this metadata. Skill
source links are generated from the same root revision instead of carrying another
pin in the bundled catalog. Internal Homelab guidance follows this repository, while
Codex's system skills follow the root Codex dependency and generated build manifest.

An available source update still needs the appropriate code/content/checksum change,
review and Homelab release. For skills, `bun run skills:sync` imports the complete original source trees at the
root pins and updates their content fingerprint. Normal checks reject metadata-only
version/revision bumps or changed original text. See [Mira skills](mira-skills.md).
No remote skill installer or upstream executable runs during discovery. Existing
schedule pauses and installation policies remain separate.
