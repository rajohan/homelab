# Mira computer driver

The computer foundation uses the unmodified, pinned `@trycua/cua-driver` 0.37.0 SDK with Bun 1.4.4. It provides a single-window adapter, a supervised private child process and a reproducible native X11 qualification. It is not registered as a Chat tool or deployed on a user's desktop yet.

## Authority and observations

The host supplies a canonical executable, PID, native window ID and explicit `background` or `foreground` delivery mode. Model input cannot choose these values. A v3 bounded capability manifest allows only `get_window_state`, `click` and `type_text` for that executable, with desktop capture disabled. The adapter further fixes every request to the chosen PID/window. Driver authority expires after five minutes or one idle minute. Browser origins require a separate browser-only runtime; this native application grant does not provide origin isolation.

`ComputerWindowSession` takes a trusted availability callback. Its host must check the current owner/run lease, local stop, pauses, connection generation and interactive OS desktop state before each call and before returning results. The driver's `desktopUnlocked` and `desktopCaptureAuthorized` fields report capture permission, **not** Windows lock state. A paired Windows companion must run in the user's interactive session and supply an independently qualified lock/sleep/disconnect check.

Each observation has one random identifier, expires after ten monotonic seconds and permits at most one input. A new observation invalidates the previous one. Overlapping calls are refused. Coordinates must fall within the observed native-resolution image; the native driver receives window-local coordinates, not desktop coordinates. No screenshot file paths or remote image URLs are read. PNG/JPEG data uses the same size, signature and dimension validation as Mira's runtime image transport. Partial accessibility trees are labelled incomplete, while a valid pixel frame remains usable.

Input never automatically changes delivery mode or retries. Driver effects remain `confirmed`, `partial`, `unverified`, `refused` or `unknown`. A resolved native call is not proof that the application changed. Errors or cancellations after dispatch are conservatively `unknown` and retire the session. Local stop immediately blocks new calls, aborts admitted calls and releases the native runtime. The native driver runs in a supervised child. Requests have a maximum ten-second deadline; cancellation, invalid replies or timeout retire that child and wait for exit, forcing termination after a two-second grace period. No input is automatically replayed on a replacement process.

The SDK's typed `TypeTextInput` currently omits `delivery_mode`. The adapter uses the official wire schema for the fixed `type_text` call with a host-fixed target and delivery mode. It exposes no generic tool execution, shell, launcher, clipboard, filesystem or permission-changing endpoint. Native `snapshotId` values are not capture IDs; the adapter does not substitute them into `CapturedCoordinates`.

## Private child lifecycle

The interactive host selects the packaged child entrypoint and working directory; neither is a model argument. `openComputerProcess` uses Mira's existing bounded private JSONL process transport. The child accepts only one initialization and fixed observe/click/type requests, refuses duplicate IDs and overlapping or oversized requests, and cannot call host tools. `ComputerWindowSession` remains responsible for fresh one-use observations and the host availability gate around those requests.

Both ends enforce five-minute total and one-minute idle limits. Parent pipe loss aborts admitted work; the child has its own two-second forced-exit fallback for stuck native cleanup. The parent waits for actual process exit before removing its private temporary directory, including any native capability manifest. Parent-enforced termination is independent of the child event loop; the child's parent-loss fallback still requires that loop to run. The packaged Windows supervisor described below additionally owns and confirms cleanup of the complete worker process tree; other platforms still need equivalent ownership before desktop activation. Native diagnostic output is drained without retaining it. Protocol failures return generic errors; possibly delivered input remains unknown.

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

## Local consent controller

The companion transport now reads consent requests, accepts one opaque target,
checks a short `access/permit` receipt and records stop on the private listener.
Pending metadata includes the original server consent deadline; discovering a request late never starts a new one-minute consent window.
A permit rechecks the same live run, pause versions, device generation, target and
scope as the executor gate. It cannot extend the original consent deadline or
reveal worker credentials. Responses are bounded and identity-checked; acceptance
and input are never retried after uncertain delivery.

`ComputerConsentController` is a single-use local lifecycle for that connection.
Its host must show the requested job and view/control scope, obtain explicit local
consent, resolve one exact native target, and independently check OS readiness.
Only an opaque UUID leaves the PC during consent; executable, PID and window
identity stay local. The controller rejects remote target overrides and freezes
the locally selected target. View-only mode removes native input tools from the
capability manifest and refuses click/type in both adapters.

Readiness and server authority are checked before startup and before/after each
operation. Permit freshness is measured from request start using a monotonic
clock. A short watchdog aborts authority when renewal stalls; successful renewals
still cannot extend the absolute session lifetime. Connection loss, local stop,
lock/readiness failure and expired or changed server authority permanently retire
the controller. Late observations are discarded and interrupted input remains
unknown. Stop aborts immediately, waits for the starting/active native port to be
reaped, then attempts a bounded server stop. Server unavailability cannot restore
local access. The caller must await cleanup before creating another controller;
failed cleanup must block replacement.

The presence-only CLI still does not instantiate the consent lifecycle. Per-run command delivery,
Chat controls, installer, signed release distribution, autostart and updater
qualification remain required before enabling screen/input on the user's PC.

## Windows local consent host

`bun run build:computer:windows-host` builds the repository-owned Windows GUI
helper using the operating system's .NET Framework compiler. It has no NuGet
packages or provider credentials. Bun remains the companion runtime and owns the
private child-process transport. The GUI helper is Windows x64, requires Windows
10 or newer and runs without elevation. It is a separate product executable,
not a PowerShell command channel or a PC listener.

The prompt identifies the exact requesting origin and job, distinguishes viewing
from input control, and requires a local window selection. Input control also
requires explicit consent to bring that window forward. No window is selected by
default. Closing or declining the prompt permanently stops that request. Its
countdown uses the original server consent deadline; approving it cannot renew
the five-minute session ceiling. The helper does not itself capture pixels or
send input, and its pipe accepts only initialization, readiness checks and stop.

Only visible, non-elevated windows in the current interactive session are offered.
The selection pins the canonical local executable, PID, process creation time and
window handle. Window destruction, identity change, session transitions, sleep,
parent loss and expiry retire the helper. Readiness independently checks both
WTS active/unlocked session information and the current input desktop; a default
input desktop alone is insufficient to detect a disconnected session. Reconnect
changes cannot resume consent. The native helper also expires if the parent stops
checking it for five seconds, independently of the UI refresh timer.

`openComputerConsentSurface` launches the fixed host with filtered OS variables
and bounded JSONL over inherited pipes. It waits for one explicit selection,
checks readiness before returning it, and exposes permanent abort plus awaited
cleanup. Unknown messages, malformed targets, late approvals, hung checks and
host-tool requests retire the process. `ComputerLocalConsentHost` owns the
returned surface and binds it to the controller and a qualified driver supervisor.
Its abort immediately retires the controller, and cleanup waits for both
processes before admitting a replacement. No device token, server credential,
screenshot or input command is sent to this host.

`bun run test:computer:windows` compiles the actual GUI binary and checks its
redirected-pipe bootstrap, strict protocol parsing, deadline rules, session-state
matrix and process/window identity checks. The native test entrypoint is compiled
separately and is not distributed. CI runs these checks and the actual Bun child
transport tests on Windows; CodeQL also analyzes the compiled C# host. Linux unit
coverage is reported separately and does not claim C# line coverage or interactive
Windows input qualification.

The GUI host, controller and driver factory now share a tested lifecycle.
`ComputerLocalConsentHost` retains the immutable selected target and exact
view/control scope, checks readiness around startup, and owns late-starting
resources. Local stop also retires idle controllers without waiting for another
command. Closing the controller reaps both native resources before attempting
server stop. Failed cleanup remains a failure on repeated close calls and must
block replacement. A late capture is discarded; an interrupted input remains
unknown and is never retried. Synthetic tests exercise the real child pipe with
the actual consent transport/controller and a fake native input port; they do not
control the test runner desktop.

This composition is not yet enabled in the presence CLI. The Windows driver factory can now use the packaged supervisor below. Per-run
command transport, Chat controls,
Windows input/lock transition acceptance, installer, download distribution,
autostart and the companion updater remain required before production activation.

## Packaged Windows worker

On Windows x64, run `bun run build:computer:windows-worker C:\absolute\empty\package`
with the pinned Bun version and a frozen install. The builder creates
`mira-computer-worker-host.exe`, `mira-computer-worker.exe` and a private
`node_modules` containing the unchanged locked SDK, its Windows native DLL/N-API
module, both JavaScript dependencies and the locked `@ubjs` Windows addon, including
package metadata and notices.
An unexpected dependency set or version requires requalification. No globally
installed Bun, SDK or source checkout is needed at runtime. The output directory
must be empty; the builder never deletes an existing installation.

The Bun worker loads the SDK from its own executable directory. Automatic dotenv,
bunfig and tsconfig loading are disabled. Package metadata loading is explicitly
enabled because the external SDK uses package exports. The supervisor fixes the
working directory to the installed package and supplies only selected OS variables;
Bun preload/shell flags and provider credentials are not inherited. Installation
integrity and authenticated update distribution are separate delivery requirements;
this package does not defend against another process modifying its installed files
with the same user's permissions.

`openWindowsComputerProcess` accepts only a trusted canonical package directory
and launches the fixed supervisor with no command arguments. The supervisor uses
Windows 10+ process-creation job attributes and an explicit three-pipe handle list.
The worker starts suspended inside an unnamed, non-inherited Job Object, with
kill-on-close and no breakaway permission, before its initial thread can run. All
descendants stay in the same ownership boundary. This controls process lifetime;
it does not sandbox filesystem or network access.

Parent pipe loss, malformed/oversized transport, child exit or the absolute
lifetime stops the job. Normal cleanup confirms zero active processes before the
supervisor returns success. Closing the supervisor unexpectedly closes its job
handle and terminates descendants. The Bun parent waits for supervisor exit,
forcing termination after two seconds if necessary. A nonzero/forced exit is
unconfirmed cleanup, permanently rejects repeated close attempts, retains the
private temporary directory and blocks a replacement controller. Startup failures
retain the same cleanup failure even when no driver port was returned. Interrupted
input is never replayed.

`bun run test:computer:windows-worker` compiles the actual supervisor and separate
harmless fixtures. It verifies child and grandchild exit after parent EOF,
supervisor termination and worker exit, with retained process handles to avoid PID
reuse. It also checks environment filtering, builds the complete package, loads
native SDK metadata from an unrelated working directory, initializes/closes the
actual private port, explicitly loads both N-API addons, and rejects each missing
DLL/N-API binary in a separate fresh process. The `@ubjs/node` wrapper must resolve
the exact packaged addon. These checks do not capture
the desktop or send input. Windows CI runs them alongside consent/controller and
cleanup-failure tests. CodeQL compiles and analyzes both C# executables without a
third-party restore. Native assertions are reported separately from TypeScript
coverage.

This qualifies packaged startup and process ownership, not interactive Windows
capture/input, lock/sleep transitions, installer signing, release distribution,
private routing or the live PC connection. The presence CLI remains unchanged.
