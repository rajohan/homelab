# Testing and coverage

Use `bun run test` for fast unit and Happy DOM component tests without coverage overhead. Use `bun run test:coverage` when inspecting coverage locally; CI uses the coverage command instead of running the same tests twice.

The runner keeps native unit tests and Happy DOM component tests in separate Bun processes. Each process writes its own LCOV file:

- `coverage/unit/lcov.info`
- `coverage/component/lcov.info`

The reports cannot overwrite each other. CI uploads these two exact files together with the `unit-component` Codecov flag. Codecov combines their coverage for the same commit, including shared source files; no repository-specific LCOV merger is needed. Generated coverage reports are Git-ignored.

`bun run test:integration` separately tests real HTTP behavior with native Bun networking. After `bun run build`, `bun run test:smoke` runs the built services and checks their HTTP responses and browser assets. These checks are not counted in the current unit/component coverage report.

## Component assertions and interaction

The Happy DOM preload registers Jest DOM matchers with Bun's native `expect`. Component tests use readable assertions such as `toBeVisible`, `toBeInTheDocument`, and `toHaveFocus`. Testing Library `user-event` exercises pointer and keyboard interactions; it does not add Jest or Vitest as a test runner. Browser production types, Bun/server types, and tests that need DOM globals are checked in separate TypeScript configurations.

## Editor runtime

Oxc discovers this repository's `oxlint.config.ts` and `oxfmt.config.ts`. The portable VS Code setting `oxc.useExecPath: true` lets Oxc use the editor's existing JavaScript runtime, including code-server's bundled Node. This is separate from the application runtime and package manager: installation, scripts, tests, and builds still use the pinned Bun version. The CLI lint command resolves Oxc's native type checker directly through `scripts/lint.ts` and does not require Node in the shell PATH.

When this repository is opened as a subdirectory of a larger workspace, VS Code does not apply its nested `.vscode/settings.json`. Enable `oxc.useExecPath` in that outer workspace as well. No machine-specific runtime path belongs in this repository. Keep nested Oxc configuration discovery enabled so project rules override broader workspace defaults.

## Codecov setup

Activate this repository in Codecov and grant its GitHub integration access to this repository. Add its repository-specific upload token as the GitHub Actions secret `CODECOV_TOKEN`. Do not reuse an unverified token from the old dashboard, commit the token or put it in a runtime application environment.

The pinned official upload action receives that secret only in the upload step. Coverage collection and all other checks run without it. Uploads are allowed on `main` pushes and trusted same-repository pull requests. Fork and Dependabot PRs still run tests and generate reports, but skip the token-dependent upload. The workflow does not use `pull_request_target` to expose credentials to untrusted code.

Codecov status checks are initially informative and compare against the measured baseline. The previous dashboard's 85% threshold and old `src/` paths are not copied into a new project without evidence. Review the first reports before agreeing on any blocking threshold, particularly for future authentication logic.

### Missing GitHub checks or comments

The CI upload token authorizes sending reports to Codecov. It does not grant Codecov permission to post GitHub checks. If the upload succeeds and Codecov shows the report as processed, verify the separate GitHub App installation: **GitHub Settings → Applications → Installed GitHub Apps → Codecov → Configure**. The repository owner must include `rajohan/homelab` in the selected repositories, or grant access to all repositories, and review any pending permission update. Activating a repository inside Codecov alone is not this permission check.

Check the PR's base and head reports as well as the CI upload log. Missing base coverage prevents a useful comparison. This repository also sets `comment.require_changes: true`, so a PR with no coverage changes may receive no comment; that alone is not an upload failure. Informational coverage checks are still configured separately from comments.

Do not add a replacement green CI job to conceal a missing Codecov notification. After correcting integration access, rerun the trusted PR's CI and verify both the processed report and GitHub's reported statuses. Keep application and homelab credentials out of this integration.

## Interpretation

Bun reports coverage of loaded source modules. A high percentage is not proof that every source file has tests, and test/preload/generated files are excluded. Review missing test scenarios and the file list, not only the overall number.

Happy DOM checks our DOM and component behavior, not a real browser's security enforcement or physical authenticators. Actual cookie/redirect behavior, YubiKey and iPhone NFC remain targeted manual acceptance checks when authentication is implemented. Coverage does not replace those tests.

## References

- [Bun code coverage](https://bun.com/docs/test/code-coverage)
- [Codecov GitHub Action](https://github.com/codecov/codecov-action)
- [Codecov report merging](https://docs.codecov.com/docs/merging-reports)
- [Codecov flags](https://docs.codecov.com/docs/flags)
