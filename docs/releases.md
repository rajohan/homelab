# Releases

The root `package.json` owns one product version. Release Please maintains the
changelog, release PR, tag and GitHub release using the existing repository-scoped
GitHub App. Review and required branch protection still apply.

## Delivery flow

1. A PR runs `CI / verify`: formatting, lint, TypeScript, migration metadata and builds.
2. After review, squash merge with a Conventional Commit title.
3. Release Please proposes the next version. Merge its reviewed release PR when ready.
4. **Container images** runs the shared formatting, lint, type and migration checks
   on the exact release commit before publishing. It then builds the release
   artifacts directly, without test suites or a duplicate application-build job.
5. Deploy through the existing backup, migration and health verification process.

`fix` proposes a patch release and `feat` a minor release. `chore(deps)` publishes
application dependency changes. Ordinary chores and GitHub Actions-only changes do
not independently trigger a release. Never move or reuse a published version tag.

## Three image builds

| Build | Contents                                                  | Registry roles       |
| ----- | --------------------------------------------------------- | -------------------- |
| Auth  | Auth runtime, CLI and migrations                          | `auth`               |
| Main  | Dashboard, worker, Mira, browser SDK/Chromium, code tools | `dashboard`          |
| Proxy | Existing shared network proxy                             | `mira-browser-proxy` |

Main is published once as `dashboard`. The release manifests retain logical roles
for Mira, browser and code jobs, all pointing to that same immutable dashboard
reference. The updater accepts only the package assigned to each logical role; it
does not retain the retired registry aliases. Service processes still run in their
existing containers with their own permissions and scoped environment.

The first upgrade from a version that requires one registry package per role needs
a manual coordinated installation of the verified release. Update the installed
image references and Mira runtime command to `/app/mira/runtime/codex`, and keep
backup, queue drain, migration and health checks. After that upgrade,
ordinary dashboard deployments consume the three published packages directly.

The Main entry point recognizes the existing Mira `HOMELAB_MIRA_CONFIG` and browser
host command; Dashboard, worker, migration and Auth commands keep their current
working directories. Browser/code containers select their existing fixed entry points.

Images use BuildKit caches, a frozen root dependency install and the pinned Bun
runtime. Distribution packages refresh at least weekly when building a release.
The release workflow also builds the Windows installer in parallel, using the same
application source and managed native SDK.

## Publication and recovery

`container-images.json`, `browser-image.json` and `daytona-image.json` retain the
existing role format and immutable digest references. The workflow attaches their
exact evidence files and the Windows manifest to its successful attempt. The updater
still requires a complete successful release and matching source/version evidence.
No floating `latest` tags are used, and no service is automatically deployed.

The publisher reuses an existing version tag only when its image config is identical.
If a rebuild differs, publish a new patch release. Do not replace an immutable tag.
Windows assets use the same immutable-byte rule.

The existing Release Please App needs Contents/Pull requests write access only.
Secrets remain `RELEASE_PLEASE_APP_CLIENT_ID` and `RELEASE_PLEASE_APP_PRIVATE_KEY`.
Actions uses its scoped token for package publication. No host credential is supplied
to CI. Keep `main` protected with `verify` and the required review policy.

See [Release Please](https://github.com/googleapis/release-please-action),
[dependency updates](dependencies.md) and [deployment](release-deployment.md).

Windows package changes also compile the installer on a Windows runner. UI-only
changes skip that workflow; it runs no acceptance or test suite.

## Publication status

Creating the GitHub release starts publication; it does not make the packages deployable. The release panel shows Publishing until the release workflow finishes, Publication failed for a failed workflow, and Verified release only after the reader validates the immutable packages and matching workflow evidence.

Opening deployment confirmation during publication performs read-only checks every 15 seconds while the dialog is open. Each completed check replaces any older preparation snapshot. No host inspection or deployment is started until the required packages are verified. A failed or incomplete publication stops these checks and links to the release build; transport or job failures retain their recorded explanation. Deployment still requires explicit confirmation of the prepared release.

After a confirmed image push, the publisher tolerates a briefly missing registry manifest with bounded reads (six attempts, 31 seconds of backoff). It never retries the push, ignores authentication failures, or overwrites a conflicting version tag. A failed publication remains unverified until matching packages and workflow evidence exist.
