# Releases

Homelab uses Release Please, following the former dashboard's GitHub App approach without carrying over its custom artifact/provisioning framework.

## One product version, independent deployments

The root `package.json` owns the product version. Private application and shared-package manifests do not maintain duplicate version numbers. Both applications are built from the same tagged source, but can be deployed independently; creating or merging a release PR does not restart either application.

The `node` Release Please strategy updates JavaScript package metadata. Its name does not change the runtime: installation, tests and builds still use Bun.

The initial source version is `0.1.0`. The release manifest starts at `0.0.0` because no Homelab release has been published yet. The first feature commit proposes `v0.1.0`. Subsequently, Release Please maintains the manifest; do not reset it or manually reuse old tags.

Only root package metadata needs a version change. Bun's root lockfile workspace does not duplicate that root version. Private workspace versions are deliberately omitted so releases do not need a custom lockfile-rewriting workflow. Dependency changes still require updating and committing `bun.lock`; CI always installs with `--frozen-lockfile`.

## Normal flow

1. Open a feature/fix PR and let CI check formatting, lint, types, unit/component tests, HTTP integration tests and both builds.
2. Squash merge with a Conventional Commit title, for example `feat(dashboard): add service inventory` or `fix(auth): reject an invalid return URL`.
3. Release Please creates or updates its release PR with the next version and changelog. Review its changes and wait for CI.
4. Merge the release PR when the version is ready. The next Release Please run creates the Git tag and GitHub release.
5. Deploy the desired application separately through the reviewed deployment process. There is no automatic production deployment in this workflow.

`fix:` increments the patch version and `feat:` increments the minor version. Before `1.0.0`, a breaking change increments the minor version under the configured pre-major policy. Document breaking changes with `!` or a `BREAKING CHANGE:` footer. Do not automatically merge release PRs or bypass their required checks.

## Required GitHub setup

Install a release automation GitHub App on this repository. The existing release App can be used if its owner deliberately adds this repository to the installation; otherwise create a dedicated App. Its repository permissions need only:

- **Contents: read and write** for the release branch, tags and releases.
- **Pull requests: read and write** for release PRs and their labels.
- The automatically granted **Metadata: read** permission.

The workflow further restricts each short-lived installation token to this repository and those write permissions. The token action revokes its token when the job finishes. It does not receive repository administration, Actions, deployment or homelab access.

Add these repository Actions secrets through GitHub's private UI or an approved secret-staging mechanism; never paste their values into chat or commit them:

| Secret                           | Value                             |
| -------------------------------- | --------------------------------- |
| `RELEASE_PLEASE_APP_CLIENT_ID`   | The release App's client ID       |
| `RELEASE_PLEASE_APP_PRIVATE_KEY` | The release App's PEM private key |

Keep the default `GITHUB_TOKEN` read-only. Ensure repository Actions policy permits the two pinned official actions. Enable squash merging and use PR titles as squash commit titles. Protect `main` with pull requests and the `verify` CI status check, after that check has run at least once. Do not grant the release App a bypass for required checks on `main`.

No personal or broad existing PAT is copied into Actions. No server-side Doppler credential is supplied to GitHub. If the App installation or secrets are missing, Release Please fails with an explicit setup message; it does not silently fall back to another identity.

## Why use an App rather than the default token?

GitHub restricts workflow chaining from `GITHUB_TOKEN`. Current GitHub documentation permits `opened`, `synchronize` and `reopened` PR events from that token, but starts the corresponding workflows in an approval-required state. Other events, including tag/release automation, remain restricted. Using the App installation token lets the normal release PR checks run automatically, as in the old repository.

The release job never checks out or executes application code while holding the App credentials. Its only tasks are creating the scoped token and running the pinned Release Please action.

## Validation and recovery

- Confirm the first release PR receives the ordinary `CI / verify` check automatically.
- Confirm `bun install --frozen-lockfile` still passes on that PR.
- Merge only after review; confirm the tag and GitHub release point at the intended commit.
- A release is not a deployment. If a deployed application must be rolled back, select its previously verified artifact/image rather than moving or deleting published Git tags.
- Failed release automation can be retried with **Actions → Release Please → Run workflow** on `main` after fixing the cause. Do not hand-edit the release bot's bookkeeping labels or manifest to hide a failure.

## References

- [Release Please Action](https://github.com/googleapis/release-please-action)
- [Manifest configuration](https://github.com/googleapis/release-please/blob/main/docs/manifest-releaser.md)
- [GitHub workflow-trigger rules](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow)
- [Create GitHub App Token](https://github.com/actions/create-github-app-token)
