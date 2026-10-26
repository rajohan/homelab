# Mira computer driver

The computer foundation uses the unmodified, pinned `@trycua/cua-driver` 0.37.0 SDK with Bun 1.4.4. It provides a single-window adapter, a supervised private child process and a reproducible native X11 qualification. It is not registered as a Chat tool or deployed on a user's desktop yet.

## Authority and observations

The host supplies a canonical executable, PID, native window ID and explicit `background` or `foreground` delivery mode. Model input cannot choose these values. A v3 bounded capability manifest allows only `get_window_state`, `click` and `type_text` for that executable, with desktop capture disabled. The adapter further fixes every request to the chosen PID/window. Driver authority expires after five minutes or one idle minute. Browser origins require a separate browser-only runtime; this native application grant does not provide origin isolation.

`ComputerWindowSession` takes a trusted availability callback. Its eventual host must check the current owner/run lease, local stop, pauses, connection generation and interactive OS desktop state before each call and before returning results. The driver's `desktopUnlocked` and `desktopCaptureAuthorized` fields report capture permission, **not** Windows lock state. A paired Windows companion must run in the user's interactive session and supply an independently qualified lock/sleep/disconnect check.

Each observation has one random identifier, expires after ten monotonic seconds and permits at most one input. A new observation invalidates the previous one. Overlapping calls are refused. Coordinates must fall within the observed native-resolution image; the native driver receives window-local coordinates, not desktop coordinates. No screenshot file paths or remote image URLs are read. PNG/JPEG data uses the same size, signature and dimension validation as Mira's runtime image transport. Partial accessibility trees are labelled incomplete, while a valid pixel frame remains usable.

Input never automatically changes delivery mode or retries. Driver effects remain `confirmed`, `partial`, `unverified`, `refused` or `unknown`. A resolved native call is not proof that the application changed. Errors or cancellations after dispatch are conservatively `unknown` and retire the session. Local stop immediately blocks new calls, aborts admitted calls and releases the native runtime. The native driver runs in a supervised child. Requests have a maximum ten-second deadline; cancellation, invalid replies or timeout retire that child and wait for exit, forcing termination after a two-second grace period. No input is automatically replayed on a replacement process.

The SDK's typed `TypeTextInput` currently omits `delivery_mode`. The adapter uses the official wire schema for the fixed `type_text` call with a host-fixed target and delivery mode. It exposes no generic tool execution, shell, launcher, clipboard, filesystem or permission-changing endpoint. Native `snapshotId` values are not capture IDs; the adapter does not substitute them into `CapturedCoordinates`.

## Private child lifecycle

The interactive host selects the packaged child entrypoint and working directory; neither is a model argument. `openComputerProcess` uses Mira's existing bounded private JSONL process transport. The child accepts only one initialization and fixed observe/click/type requests, refuses duplicate IDs and overlapping or oversized requests, and cannot call host tools. `ComputerWindowSession` remains responsible for fresh one-use observations and the host availability gate around those requests.

Both ends enforce five-minute total and one-minute idle limits. Parent pipe loss aborts admitted work; the child has its own two-second forced-exit fallback for stuck native cleanup. The parent waits for actual process exit before removing its private temporary directory, including any native capability manifest. Parent-enforced termination is independent of the child event loop; the child's parent-loss fallback still requires that loop to run. OS-level process-tree ownership must be qualified before desktop activation. Native diagnostic output is drained without retaining it. Protocol failures return generic errors; possibly delivered input remains unknown.

The child receives only explicitly selected OS/display variables. Provider tokens, database credentials, GitHub credentials, preload flags and other environment variables are omitted, and Bun dotenv loading is disabled. Display variables necessarily convey local desktop access. This is process supervision and driver scoping, **not an OS sandbox**: it does not remove the user's filesystem or network permissions. The native child source entrypoint is qualified only in the disposable image; packaging it into the presence companion, OS readiness checks and production activation remain separate work.

## Computer pairing foundation

Computer enrollment belongs to the signed-in Homelab operator. Creating or revoking a pairing requires the existing recent human/MFA verification, and machine principals cannot call these management procedures. A ticket expires after ten minutes and can be consumed exactly once. Only its SHA-256 verifier is stored. Successful enrollment replaces it with a distinct, computer-only credential that expires after thirty days; a lost enrollment response requires a new ticket. No credential or verifier is returned by list APIs or copied into audit records.

The companion initiates outbound HTTPS requests to `/api/mira/computers/enroll`, `/connect` and `/heartbeat`. Credentials belong only in the Authorization header, never URLs, browser cookies, logs or model context. The machine endpoint rejects browser Origin/Cookie headers and accepts only bounded JSON bodies with a five-second read deadline and eight concurrent receivers. The separate private route must terminate TLS. The companion enforces HTTPS, certificate verification and redirect refusal.

A connection has a server-issued generation, fifteen-second heartbeat cadence and forty-five-second lease. A new connection invalidates the previous generation; stale, duplicate or expired heartbeats cannot restore it. Revocation atomically removes both credential verifiers and the connection. Ticket creation is serialized per owner, with at most twenty live enrollments/computers and twenty tickets per hour. Metadata lists contain only the current owner's fifty most relevant records.

**Pairing and a fresh heartbeat do not authorize input or prove the desktop is ready.** Every machine receipt explicitly reports `controlAllowed: false`. No model tools, window selection, screenshot or input endpoints are registered by this foundation. Companion release distribution, authenticated run grants, local stop/takeover, OS readiness, process-tree ownership and update qualification remain required before control activation. Installation/platform/version fields are self-reported metadata, not a trust attestation.

## Repeatable qualification

Run `bun run test:computer` on a Docker-capable development host. The command builds the repository's fixture image and runs it with no network, no host desktop/device mounts, no capabilities, no elevated privileges and a read-only filesystem with bounded temporary storage. The SDK remains an ordinary repository dependency, covered by lockfile and dependency updates; the disposable image is not a new deployed service.

The image starts Xvfb, Openbox and a synthetic Tk window, waiting for the display, window manager and visible application before publishing readiness. The qualification performs native operations through the supervised child. It reads an inline image, focuses the entry, types a literal string and clicks a counter. It verifies the text and exactly one increment through the fixture's separate state file. It also checks denied desktop discovery, denied out-of-manifest executable access, one-use observations and closed-session refusal. It prints only a content-free receipt. CI runs the same command in the existing secret-free source-verification job.

Unit tests also run real synthetic child processes to verify hung initialization, hung input, cancellation, parent EOF, forced termination, process reaping, temporary cleanup, environment filtering and disabled dotenv loading. Protocol tests reject privilege-widening requests and suppress late results after pipe loss. Other tests cover scope validation, stale/superseded/cross-session observations, out-of-bounds input, overlapping calls, host revocation, cancellation, unknown results, malformed frames, native cleanup and exact fixed-tool request mapping.

Passing this fixture qualifies Linux X11 with explicit foreground input. It does not qualify Windows, Wayland, browser origin handling, background keyboard input, OS lock detection or production computer access. Remaining delivery work includes a packaged companion, outbound pairing, session grants, stop/takeover/revoke controls, Windows/browser acceptance and updater integration for the deployed companion artifact.

Upstream references: [SDK](https://cua.ai/docs/cua-driver/guides/use-the-sdk), [permission manifests](https://cua.ai/docs/cua-driver/guides/permissions), [platform limits](https://cua.ai/docs/cua-driver/concepts/platform-support).

## Companion and private network

The main dashboard listener always returns 404 for machine computer endpoints. The separate listener is disabled by default. Explicit `HOMELAB_MIRA_COMPUTER_HOST` and `HOMELAB_MIRA_COMPUTER_PORT` opt in with an exact loopback, RFC1918 or Meshnet CGNAT IPv4 address; public addresses and wildcard binds are rejected. Identity and operations configuration are required. The private listener serves only the bounded machine protocol, never browser sessions or tRPC. It stops with the dashboard.

For this homelab, computer traffic must use the existing NordVPN Meshnet route. Keep the dedicated TLS hostname on private DNS/routing, permit only the intended Meshnet peers or their existing routed LAN path, and expose no public reverse-proxy router or port forward. Binding a private address alone does not prove Meshnet isolation: qualify firewall rules, DNS, IPv6 and any proxy forwarding before activation. Loss of Meshnet must interrupt the companion, without a public fallback. The companion opens no listener on the PC. No network policy or production service is changed by building this PR.

Settings > Computers creates a ten-minute, single-use pairing code, lists presence and revokes pairings after recent human verification. Connected means that the server received a fresh heartbeat; it does not claim screen readiness. Revoked/expired pairings remain identifiable. Closing the code dialog clears its transient UI state.

Build with Bun 1.4.4: `bun run build:computer linux-x64` or `bun run build:computer windows-x64`. Artifacts are under `apps/mira/dist/computer/<platform>/`. These presence-only executables contain their Bun runtime and disable automatic dotenv, bunfig, package.json and tsconfig loading. Native input is not included. Release publication and updater qualification remain separate work.

On the PC, run `mira-computer pair https://computer.home.example.test`. Paste the ticket into the hidden prompt, never into command arguments, environment variables or a file. Enrollment is sent once; an uncertain response requires revoking the ticket and creating another. The credential is stored in the current user's OS vault using [Bun's credential API](https://bun.sh/docs/runtime/secrets), with Windows `persist: local`, no unrestricted keychain access and no plaintext fallback. A failed save requires revocation in Settings. The vault key is bound to the canonical origin, so another server cannot receive that credential.

`mira-computer run <origin>` connects and reports presence until Ctrl+C. Temporary outages reconnect after thirty seconds; credential/generation rejection stops instead of fighting another companion. `mira-computer forget <origin>` deletes the local key only; revoke in Settings to end already running connections. No background installation, autostart, provider credentials or remote command execution is enabled.

The compiled presence executable was run on Windows x64 with `--version` and `--help`. `apps/mira/src/server/testing/computerVault.ts` separately qualified the real Windows vault using one random synthetic origin and confirmed removal afterward. This does not qualify native Windows input, lock detection or the live Meshnet route. The builder uses the pinned Bun CLI: its Windows output was exercised directly, rather than inferring executable readiness from a successful cross-compilation.

## Per-run access protocol

The server now stores a separate, short-lived permission for one running job and
one paired computer. `mira.computers.access.request` requires fresh human MFA and
an exact displayed computer version. A request is only pending consent: the
presence-only companion does not consume it or enable native control yet. Chat
controls and the local consent UI will use this protocol in a later slice.

The permission captures the current worker lease, computer connection generation,
view-only/input scope, automation definition and relevant pause-control versions.
Only one pending/active permission can exist per computer and per run. A local
consent request expires after one minute; all authority expires within five
minutes and no later than the job's budget or device credential. Requests are
limited to twenty per account per hour, including stopped requests.

The private machine listener exposes `access/pending`, `access/accept` and
`access/stop`. Acceptance is single-use and binds an opaque, locally generated
window selection ID. The executable, PID, window handle and screenshots are not
part of this protocol. A future companion must obtain explicit local consent,
keep that ID mapped to the immutable host-selected target, retire any previous
local controller before accepting a new session, and enforce OS
readiness before opening the native driver. These endpoints alone cannot read
screens or send input. Enrollment and heartbeat receipts remain
`controlAllowed: false`; presence is never a computer-use capability.

The executor's `requireMiraComputerAccess` gate verifies the exact owner, run
lease, current connection, target and requested action scope. Its dispatch
ceiling is at most five seconds, further bounded by all current lease deadlines.
A transport must measure this from the start of the request using a monotonic
clock, recheck before dispatch and after completion, close on a failed gate or
lost connectivity, and never replay uncertain input. It is not a renewable
standalone bearer credential. OS lock/sleep checks and native process ownership
remain required before actual desktop control can be enabled.

Human stop is idempotent and does not require another MFA challenge or an
optimistic version. Local stop first closes the native session and then records
the stop on the server; reconnecting must never restore it. Cancellation,
completion, expired leases, pairing revocation, deleted conversations and changed
pause-control versions all invalidate access. Resuming a pause requires a new
human request and new local consent. Stop records durable denial; it does not
claim an already dispatched OS action was undone.
