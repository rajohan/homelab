# Testing and coverage

Use `bun run test` for fast unit and Happy DOM component tests without coverage overhead. Use `bun run test:coverage` when inspecting coverage locally; CI uses the coverage command instead of running the same tests twice.

The runner keeps native unit tests and Happy DOM component tests in separate Bun processes. Each process writes its own LCOV file:

- `coverage/unit/lcov.info`
- `coverage/component/lcov.info`

The reports cannot overwrite each other. CI uploads these two exact files together with the `unit-component` Codecov flag. Codecov combines their coverage for the same commit, including shared source files; no repository-specific LCOV merger is needed. Generated coverage reports are Git-ignored.

`bun run test:integration` separately tests real HTTP behavior with native Bun networking. After `bun run build`, `bun run test:smoke` runs the built services and checks their HTTP responses and browser assets. These checks are not counted in the current unit/component coverage report.

## Codecov setup

Activate this repository in Codecov and grant its GitHub integration access to this repository. Add its repository-specific upload token as the GitHub Actions secret `CODECOV_TOKEN`. Do not reuse an unverified token from the old dashboard, commit the token or put it in a runtime application environment.

The pinned official upload action receives that secret only in the upload step. Coverage collection and all other checks run without it. Uploads are allowed on `main` pushes and trusted same-repository pull requests. Fork and Dependabot PRs still run tests and generate reports, but skip the token-dependent upload. The workflow does not use `pull_request_target` to expose credentials to untrusted code.

Codecov status checks are initially informative and compare against the measured baseline. The previous dashboard's 85% threshold and old `src/` paths are not copied into a new project without evidence. Review the first reports before agreeing on any blocking threshold, particularly for future authentication logic.

## Interpretation

Bun reports coverage of loaded source modules. A high percentage is not proof that every source file has tests, and test/preload/generated files are excluded. Review missing test scenarios and the file list, not only the overall number.

Happy DOM checks our DOM and component behavior, not a real browser's security enforcement or physical authenticators. Actual cookie/redirect behavior, YubiKey and iPhone NFC remain targeted manual acceptance checks when authentication is implemented. Coverage does not replace those tests.

## References

- [Bun code coverage](https://bun.com/docs/test/code-coverage)
- [Codecov GitHub Action](https://github.com/codecov/codecov-action)
- [Codecov report merging](https://docs.codecov.com/docs/merging-reports)
- [Codecov flags](https://docs.codecov.com/docs/flags)
