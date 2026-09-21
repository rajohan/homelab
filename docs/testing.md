# Testing and coverage

Use `bun run test` for fast unit and Happy DOM component tests without coverage overhead. Use `bun run test:coverage` when inspecting coverage locally; CI uses the coverage command instead of running the same tests twice.

The runner uses `--parallel=2 --no-isolate` for every unit, component, integration and
coverage group. Workers reuse globals and module caches between files. Happy DOM runs
in a separate group from native Bun networking; each component test cleans its DOM.
Tests must restore mocks, globals, servers and connections rather than relying on
per-file isolation. The command regression test enforces these flags.

Every discovered test must have exactly one finite, nonnegative timing in its group's
committed inventory. Missing, stale or invalid entries fail `bun run check` and normal
test runs. Update measured values with `bun run test:timings` and
`bun run test:integration:timings` (the latter requires the disposable PostgreSQL server).
Updates use temporary files and are accepted only after successful tests and exact
inventory validation. CI never regenerates timings automatically.

Each group writes its own LCOV file:

- `coverage/unit/lcov.info`
- `coverage/component/lcov.info`
- `coverage/integration/lcov.info` (from `bun run test:integration:coverage`)

Run `bun run test:coverage:check` after both coverage commands. It merges the three
exact reports with the same LCOV library used by Mira-Dashboard, rejects missing
executable source files and writes `coverage/lcov.info`. CI performs this check before
uploading that one report with the `unit-component-integration` flag. Each group removes
its previous report before running, so a failed run cannot reuse that group's stale file.
Generated coverage reports are Git-ignored.

`bun run test:integration` tests real HTTP behavior with native Bun networking and a disposable PostgreSQL database. Set `HOMELAB_TEST_DATABASE_URL` to a loopback database named exactly `homelab_auth_test`; each concurrent suite creates and removes its own database on that test server. CI creates PostgreSQL 18 as an isolated service. Never point these tests at production. After `bun run build`, `bun run test:smoke` runs the built services and checks their HTTP responses and browser assets. It also requires the isolated test database and exercises the built migration/user CLI and two separate configured processes through real OIDC login, account access and logout. Integration coverage is uploaded alongside unit/component coverage. Built smoke checks are deliberately outside source coverage.

## Component assertions and interaction

`bun run test:docker` requires a local Docker Engine, Compose and the cached
`postgres:18` image (CI's database service supplies it). It creates uniquely labelled,
bounded disposable containers running only `sleep`, never production applications.
The actual Docker HTTP transport and coordinator exercise start/stop/restart,
namespace dependency ordering, paused/stopped states, stale confirmations,
cancellation and missing-provider refusal. The unmocked Python updater exercises
pull/inspect, literal pin changes, Compose recreation, persistent fixture data,
namespace rebinding and refusal of unapproved consumers. It uses immutable aliases
of the same cached image, not real application upgrades. Cleanup verifies exact
fixture ownership before removing its containers and volumes. These tests complement
HTTP/PostgreSQL tests for admission, leases, receipts, batching and notifications;
they do not certify arbitrary third-party releases or production-private workflows.

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

Bun reports only loaded modules. Coverage-only preloads therefore import executable
application, package, tooling and root TypeScript configuration modules in their proper
runtime. Tool commands are guarded by `import.meta.main`: importing one never runs a
build, migration or development server. Component smoke tests mount and unmount the
two real browser entrypoints. The independent source-inventory gate rejects any missing
module, including a newly added untested file. Type-only modules, declarations, tests,
test fixtures, dependencies and build output are excluded; CSS and static assets do not
have executable JavaScript line coverage. Loading a module is not a behavioral test:
uncalled functions remain uncovered and the percentage must be read accordingly.

The complete inventory initially measures about 72.5% line coverage. The previous partial
report is not a comparable baseline. No threshold was lowered or source excluded to
conceal this change; Codecov remains informational as documented above.

Happy DOM checks our DOM and component behavior, not a real browser's security enforcement or physical authenticators. Actual cookie/redirect behavior, YubiKey and iPhone NFC remain targeted manual acceptance checks before the identity preview replaces production. Coverage does not replace those tests.

## References

- [Bun code coverage](https://bun.com/docs/test/code-coverage)
- [Codecov GitHub Action](https://github.com/codecov/codecov-action)
- [Codecov report merging](https://docs.codecov.com/docs/merging-reports)
- [Codecov flags](https://docs.codecov.com/docs/flags)

## Identity coverage

The integration suite exercises Argon2id sign-in, CSRF/origin rejection, stale-proof mutation
replay, TOTP replay protection, simultaneous recovery-code consumption, signed WebAuthn
registration/assertions with wrong-origin and missing-UV rejection, NFC transport retention,
ownership checks, idle expiry, email verification and password recovery. It also runs actual
OIDC code/S256 exchange, code reuse rejection, refresh rotation, RP logout, central revocation,
ForwardAuth host/nonce binding and the independent dashboard BFF.

Happy DOM tests the nested modal workflow and preservation/cancellation of the original
operation. It does not emulate a hardware security key or assert Safari's NFC support.

The disposable `bun run dev:identity` flow is also suitable for manual acceptance using
synthetic accounts. Browser/device testing must not use the production account database.

## Responsive theme and compiler checks

Use the disposable identity preview to inspect both auth and dashboard at 320px/390px,
tablet and desktop widths. Check navigation, long account values, scrolling, focus and
security dialogs. Happy DOM does not calculate browser layout, so component tests alone
cannot certify responsiveness.

The shared base uses Mira's dark palette and scrollbar treatment, but leaves long pages
vertically scrollable rather than copying the old shell's global `overflow: hidden`.
App CSS entrypoints contain only the shared import and local Tailwind source registration.

Bun's production build enables its native React Compiler; the build regression checks
verify generated memoization without Babel or another runtime. Development keeps Bun's
Fast Refresh pipeline. `scripts/development/routerHmr.ts` defers one eager TanStack
RouterCore binding that otherwise fails during Bun's development module cycle. It changes
only the in-memory development bundle, not installed dependencies or production output.
The test checks the installed upstream implementation and fails on an incompatible update.
Remove the workaround once an upstream Bun/Router combination passes the same browser check.

## Remote loopback preview

Set `HOMELAB_PREVIEW_PORT=3200` when starting `bun run dev:identity` to run a second
isolated preview without resetting the existing one. Auth uses the following port
(3201), with matching OIDC origins/callbacks. The default remains 3100/3101. Each
process owns its own temporary database and removes it on graceful shutdown.

Preview update jobs simulate native applications and separate runtime updates as well
as Docker/APT. Synthetic restart observations use only the demo database. None of these
executors opens SSH, runs a package manager or contacts a production control endpoint.

Shared table headers follow Mira's ascending/descending/unsorted controls. Bounded
inventories sort raw values; paginated histories sort their complete authorized data
before fetching a page. Regression tests cover numeric order, nulls, stable ID ties,
removed cursor rows, account isolation and microsecond timestamp boundaries. A paged
table must supply server-side sorting rather than sorting only its loaded rows.

When forwarding the preview from Main, bind the SSH listeners to `localhost`, not
only `127.0.0.1`. The browser may connect to `::1`; both loopback families must reach
the same preview. An IPv4-only tunnel can make browser requests time out even when
an HTTP client succeeds after falling back to IPv4. Keep the app listeners on Main
loopback-only; do not expose the preview on the LAN or disable IPv6.

The shared input keeps visible labels separate from optional placeholders. Hover
and focus use the Mira accent, while invalid and disabled states remain distinct.
Transport failures use actionable messages and never automatically replay a mutation
whose outcome is unknown.

## Form validation and feedback

Shared forms disable browser-native validation popups. TanStack Form runs the same
Valibot and cross-field rules while values change, when a field loses focus, and
before submission. Errors remain hidden on untouched fields until submission and
are associated with their inputs through accessible descriptions and invalid state.
Blur reuses change validation so an old blur error cannot survive a corrected value.
Tests cover empty submission, invalid email, password length and confirmation,
correction without refocusing, and form-local server errors.

Account confirmations appear in the section that owns the action: profile, security
methods or sessions. Starting another action clears the previous notice. Email
verification uses "Check your inbox for a verification link." rather than claiming
that a queued email has already been delivered. Reset and verification pages replace
their completed forms with a local confirmation instead of leaving a reusable token form.

Security regressions exercise last-factor removal with live access and refresh tokens,
including that re-enrollment does not revive revoked grants. BFF tests send foreign,
null and missing origins with a valid dashboard cookie and assert that rejected requests
do not advance the central session's activity timestamp. Browser-client unit tests use
deferred WebAuthn results to check cancellation and identity changes before the finish
request, without invoking a physical authenticator.

## Editor TypeScript and runtime

Checks use the lockfile-pinned TypeScript 7.0.2 compiler through Bun. For the editor,
install Microsoft's `TypeScriptTeam.native-preview` (display name: TypeScript 7), enable
`js/ts.experimental.useTsgo` and select the workspace `node_modules/typescript` SDK.
The repository includes these settings when opened as a folder. If it is nested below
another workspace root, put the settings on that actual workspace and adjust the SDK path.
These are window-scoped settings, not per-nested-directory switches.

Do not point a legacy `typescript.tsdk` at TypeScript 7's `lib` directory: the native
compiler uses its LSP server, not the old JavaScript `tsserver.js`. After allowing the
workspace SDK, the TypeScript output must show 7.0.2 from this repository, not just
the version bundled with the extension. Keep lint and `bun run typecheck` enabled;
changing the language server is not a reason to suppress diagnostics.

The application, CLI, scripts, builds and tests run with Bun. `Bun.password` provides
Argon2id, `Bun.CryptoHasher` provides SHA-256, and Web Crypto supplies secure random
bytes. Remaining `node:` imports use Bun's compatibility APIs, not a Node process:
AES-GCM and constant-time comparison, OIDC's required HTTP request/response interface,
key-generation fixtures and filesystem/path/module utilities. Web Crypto's AES-GCM is
asynchronous; keep the existing synchronous AEAD envelope rather than changing all
storage/protocol call contracts solely to remove an import prefix.
