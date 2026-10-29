# Mira computer driver

The computer foundation uses the unmodified, pinned `@trycua/cua-driver` 0.37.0 SDK with Bun 1.4.4. It provides a single-window adapter, a supervised private child process and a reproducible native X11 qualification. Chat tools, per-run access controls and the installed Windows composition are implemented. Production PC activation still requires interactive qualification, private routing and release delivery.

## Authority and observations

The host supplies a canonical executable, PID, native window ID and explicit `background` or `foreground` delivery mode. Model input cannot choose these values. A v3 bounded capability manifest allows only `get_window_state`, `click` and `type_text` for that executable, with desktop capture disabled. The adapter further fixes every request to the chosen PID/window. Driver authority expires after five minutes or one idle minute. Browser origins require a separate browser-only runtime; this native application grant does not provide origin isolation.

`ComputerWindowSession` takes a trusted availability callback. Its host must check the current owner/run lease, local stop, pauses, connection generation and interactive OS desktop state before each call and before returning results. The driver's `desktopUnlocked` and `desktopCaptureAuthorized` fields report capture permission, **not** Windows lock state. A paired Windows companion must run in the user's interactive session and supply an independently qualified lock/sleep/disconnect check.

Each observation has one random identifier, expires after ten monotonic seconds and permits at most one input. A new observation invalidates the previous one. Overlapping calls are refused. Windows observations expose bounded `elements` (token, role and label) and `coordinateInput: false`. `click_element` accepts only a token present in that same fresh observation. Disabled or degraded elements are not advertised. Labels are untrusted UI content, never instructions. Native raw tree text is not sent through the machine endpoint. On platforms advertising coordinate input, coordinates must fall within the observed native-resolution image; the native driver receives window-local coordinates, not desktop coordinates. No screenshot file paths or remote image URLs are read. PNG/JPEG data uses the same size, signature and dimension validation as Mira's runtime image transport. Partial accessibility trees are labelled incomplete, while a valid pixel frame remains usable.

Input never automatically changes delivery mode or retries. Driver effects remain `confirmed`, `partial`, `unverified`, `refused` or `unknown`. A resolved native call is not proof that the application changed. Errors or cancellations after dispatch are conservatively `unknown` and retire the session. Local stop immediately blocks new calls, aborts admitted calls and releases the native runtime. The native driver runs in a supervised child. Requests have a maximum ten-second deadline; cancellation, invalid replies or timeout retire that child and wait for exit, forcing termination after a two-second grace period. No input is automatically replayed on a replacement process.

The SDK's typed `TypeTextInput` currently omits `delivery_mode`. The adapter uses the official wire schema for the fixed `type_text` call with a host-fixed target and delivery mode. It exposes no generic tool execution, shell, launcher, clipboard, filesystem or permission-changing endpoint. Native `snapshotId` values are not capture IDs; the adapter does not substitute them into `CapturedCoordinates`.

## Private child lifecycle

The interactive host selects the packaged child entrypoint and working directory; neither is a model argument. `openComputerProcess` uses Mira's existing bounded private JSONL process transport. The child accepts only one initialization and fixed observe/click/click_element/type requests, refuses duplicate IDs and overlapping or oversized requests, and cannot call host tools. `ComputerWindowSession` remains responsible for fresh one-use observations and the host availability gate around those requests.

Both ends enforce five-minute total and one-minute idle limits. Parent pipe loss aborts admitted work; the child has its own two-second forced-exit fallback for stuck native cleanup. The parent waits for actual process exit before removing its private temporary directory, including any native capability manifest. Parent-enforced termination is independent of the child event loop; the child's parent-loss fallback still requires that loop to run. The packaged Windows supervisor described below additionally owns and confirms cleanup of the complete worker process tree; other platforms still need equivalent ownership before desktop activation. Native diagnostic output is drained without retaining it. Protocol failures return generic errors; possibly delivered input remains unknown.

The child receives only explicitly selected OS/display variables. Provider tokens, database credentials, GitHub credentials, preload flags and other environment variables are omitted, and Bun dotenv loading is disabled. Display variables necessarily convey local desktop access. This is process supervision and driver scoping, **not an OS sandbox**: it does not remove the user's filesystem or network permissions. The packaged Windows supervisor and independent consent/readiness host are described below. Production activation remains separate from building and testing the package.

## Computer pairing foundation

Computer enrollment belongs to the signed-in Homelab operator. Creating or revoking a pairing requires the existing recent human/MFA verification, and machine principals cannot call these management procedures. A ticket expires after ten minutes and can be consumed exactly once. Only its SHA-256 verifier is stored. Successful enrollment replaces it with a distinct, computer-only credential that expires after thirty days; a lost enrollment response requires a new ticket. No credential or verifier is returned by list APIs or copied into audit records.

The companion initiates outbound HTTPS requests to `/api/mira/computers/enroll`, `/connect` and `/heartbeat`. Credentials belong only in the Authorization header, never URLs, browser cookies, logs or model context. The machine endpoint rejects browser Origin/Cookie headers and accepts only bounded JSON bodies with a five-second read deadline and eight concurrent receivers. The separate private route must terminate TLS. The companion enforces HTTPS, certificate verification and redirect refusal.

A connection has a server-issued generation, fifteen-second heartbeat cadence and forty-five-second lease. A new connection invalidates the previous generation; stale, duplicate or expired heartbeats cannot restore it. Revocation atomically removes both credential verifiers and the connection. Ticket creation is serialized per owner, with at most twenty live enrollments/computers and twenty tickets per hour. Metadata lists contain only the current owner's fifty most relevant records.

**Pairing and a fresh heartbeat do not authorize input or prove the desktop is ready.** Every machine receipt explicitly reports `controlAllowed: false`. The separate per-run grant, local consent and command queue described below are required for screen/input access. Release distribution, interactive qualification and update qualification remain required before production activation. Installation/platform/version fields are self-reported metadata, not a trust attestation.

## Repeatable qualification

Run `bun run test:computer` on a Docker-capable development host. The command builds the repository's fixture image and runs it with no network, no host desktop/device mounts, no capabilities, no elevated privileges and a read-only filesystem with bounded temporary storage. The SDK remains an ordinary repository dependency, covered by lockfile and dependency updates; the disposable image is not a new deployed service.

The image starts Xvfb, Openbox and a synthetic Tk window, waiting for the display, window manager and visible application before publishing readiness. The qualification performs native operations through the supervised child. It reads an inline image, focuses the entry, types a literal string and clicks a counter. It verifies the text and exactly one increment through the fixture's separate state file. It also checks denied desktop discovery, denied out-of-manifest executable access, one-use observations and closed-session refusal. It prints only a content-free receipt. CI runs the same command in the existing secret-free source-verification job.

Unit tests also run real synthetic child processes to verify hung initialization, hung input, cancellation, parent EOF, forced termination, process reaping, temporary cleanup, environment filtering and disabled dotenv loading. Protocol tests reject privilege-widening requests and suppress late results after pipe loss. Other tests cover scope validation, stale/superseded/cross-session observations, out-of-bounds input, overlapping calls, host revocation, cancellation, unknown results, malformed frames, native cleanup and exact fixed-tool request mapping.

Passing this fixture qualifies Linux X11 with explicit foreground input. It does not qualify Windows, Wayland, browser origin handling, background keyboard input, OS lock detection or production computer access. Remaining delivery work includes interactive Windows/browser acceptance, installation, release distribution and updater integration for the deployed companion artifact.

Upstream references: [SDK](https://cua.ai/docs/cua-driver/guides/use-the-sdk), [permission manifests](https://cua.ai/docs/cua-driver/guides/permissions), [platform limits](https://cua.ai/docs/cua-driver/concepts/platform-support).

## Companion and private network

The main dashboard listener always returns 404 for machine computer endpoints. The separate listener is disabled by default. Explicit `HOMELAB_MIRA_COMPUTER_HOST` and `HOMELAB_MIRA_COMPUTER_PORT` opt in with an exact loopback, RFC1918 or Meshnet CGNAT IPv4 address; public addresses and wildcard binds are rejected. Identity and operations configuration are required. The private listener serves only the bounded machine protocol, never browser sessions or tRPC. It stops with the dashboard.

For Docker, the optional `deploy/compose.computer.yaml` overlay supplies a fixed
private bridge address and loopback-only host port. The normal dashboard port never
proxies machine requests. A same-host private TLS proxy provides the PC-facing
Meshnet route; see [deployment configuration and qualification](../deploy/README.md#optional-mira-and-private-computer-receiver).
The overlay itself does not configure DNS, TLS or firewall policy.

For this homelab, computer traffic must use the existing NordVPN Meshnet route. Keep the dedicated TLS hostname on private DNS/routing, permit only the intended Meshnet peers or their existing routed LAN path, and expose no public reverse-proxy router or port forward. Binding a private address alone does not prove Meshnet isolation: qualify firewall rules, DNS, IPv6 and any proxy forwarding before activation. Loss of Meshnet must interrupt the companion, without a public fallback. The companion opens no listener on the PC. No network policy or production service is changed by building this PR.

Settings > Computers creates a ten-minute, single-use pairing code, lists presence and revokes pairings after recent human verification. Connected means that the server received a fresh heartbeat; it does not claim screen readiness. Revoked/expired pairings remain identifiable. Closing the code dialog clears its transient UI state.

Build the entrypoint with Bun 1.4.4: `bun run build:computer linux-x64` or `bun run build:computer windows-x64`. Artifacts are under `apps/mira/dist/computer/<platform>/`. The executable contains its Bun runtime and disables automatic dotenv, bunfig, package.json and tsconfig loading. Windows `run` requires the complete package built with `build:computer:windows`, described below. Release publication and updater qualification remain separate work.

On the PC, run `mira-computer pair https://computer.home.example.test`. Paste the ticket into the hidden prompt, never into command arguments, environment variables or a file. Enrollment is sent once; an uncertain response requires revoking the ticket and creating another. The credential is stored in the current user's OS vault using [Bun's credential API](https://bun.sh/docs/runtime/secrets), with Windows `persist: local`, no unrestricted keychain access and no plaintext fallback. A failed save requires revocation in Settings. The vault key is bound to the canonical origin, so another server cannot receive that credential.

`mira-computer run <origin>` connects and reports presence until Ctrl+C. Temporary outages reconnect after thirty seconds; credential/generation rejection stops instead of fighting another companion. `mira-computer forget <origin>` deletes the local key only; revoke in Settings to end already running connections. Windows additionally waits for per-run requests and local approval before the bounded screen/input protocol can execute. No background installation or provider credentials are enabled by the CLI. Optional startup is configured by the installer below.

The compiled presence executable was run on Windows x64 with `--version` and `--help`. `apps/mira/src/server/testing/computerVault.ts` separately qualified the real Windows vault using one random synthetic origin and confirmed removal afterward. This does not qualify native Windows input, lock detection or the live Meshnet route. The builder uses the pinned Bun CLI: its Windows output was exercised directly, rather than inferring executable readiness from a successful cross-compilation.

## Per-run access protocol

The server now stores a separate, short-lived permission for one running job and
one paired computer. `mira.computers.access.request` requires fresh human MFA and
an exact displayed computer version. A request is only pending consent: the
installed Windows companion must obtain a separate local approval before accepting
it. Chat controls and the local consent UI use the same protocol.

The permission captures the current worker lease, computer connection generation,
view-only/input scope, automation definition and relevant pause-control versions.
Only one pending/active permission can exist per computer and per run. A local
consent request expires after one minute; all authority expires within five
minutes and no later than the job's budget or device credential. Requests are
limited to twenty per account per hour, including stopped requests.

The private machine listener exposes `access/pending`, `access/accept` and
`access/stop`. Acceptance is single-use and binds an opaque, locally generated
window selection ID. The executable, PID, window handle and screenshots are not
part of this protocol. The installed companion must obtain explicit local consent,
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

The installed Windows CLI instantiates this lifecycle. Installer, verified release
downloads, updates and optional startup are described below. Interactive Windows
and private routing qualification remain required before production activation.

## Hosted Windows native qualification

The pinned 0.37 Windows backend omits the optional `screenshotFrameValid` field,
including with full output. The adapter accepts that omission only on Windows;
an explicit `false` is always rejected. It still requires the selected PID/window,
a snapshot, exactly one bounded PNG/JPEG image, and decoded image dimensions that
match the reported size. Other platforms continue to require a positive validity
flag. See the [pinned Windows capture response](https://github.com/trycua/cua/blob/cua-driver-rs-v0.37.0/libs/cua-driver/rust/crates/platform-windows/src/tools/impl_.rs#L1748-L1779).

The Windows release job now drives a separate synthetic WinForms window through
its extracted, pinned worker package. It checks a real window image, literal text
and a counter increment against state read independently from the fixture. It also
checks view-only input refusal, the executable permission boundary, one-use
observations and confirmed worker/fixture shutdown. Fixture commands can only read
state or close the window; they cannot set the text or counter being verified.

The fixture is compiled into the owned test directory, never into release assets.
It runs only on disposable GitHub-hosted Windows runners and has a one-minute
lifetime with parent-pipe cleanup. Screenshots stay in process memory and only a
content-free result is logged. Local package checks do not start this input test.
A failure prevents the archive from being handed to installer qualification or
publication.

This qualifies the native worker and input adapter on the hosted Windows image.
It does not approve a window, activate Raymond's PC, qualify the local consent UI,
prove lock/sleep transitions or test the private Meshnet route. Those still require
explicit interactive acceptance on the intended PC before production activation.

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

The installed Windows CLI composes this host with the packaged supervisor below.
Windows input/lock transition acceptance and private routing qualification remain
required before production activation. Installation, updates and startup use the
qualified package and per-user installer described below.

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
private routing or the live PC connection.

## Connection-owned consent lifecycle

`runComputerPresence` can now own a local connection task alongside heartbeat
renewal. A slow consent prompt does not block heartbeat. Each connection gets a
new permanent stop signal; heartbeat failure, connection-work failure or local
shutdown aborts that generation and waits for both tasks to finish. Only then may
a temporary outage reconnect after the existing delay. Unexpected task completion
or unconfirmed cleanup is terminal. Cleanup failures remain visible even during
local shutdown, and a task that has not completed cleanup blocks replacement.

`runComputerConsentLoop` supplies the sequential consent lifecycle for that task.
It creates a local host, checks pending access, and invokes accepted-session work
only after the existing controller has obtained local consent, server acceptance,
fresh permits and native readiness. Closing a local window or declining a request
retires that attempt, including an in-flight pending/accept/permit request.
Cancellation is tied to its original signal; an unrelated failure after a signal
was aborted is not treated as cancellation. Accepted-session work must finish
its own teardown, and an unexpected teardown failure blocks replacement. Every attempt is fully cleaned up before another host can
be created. It retains claimed request IDs for the entire generation, including
failed/declined attempts whose stop acknowledgement was lost, so polling cannot
reopen the same prompt. The bounded ID set never evicts old requests; exhausting
it requires operator action. A new connection invalidates old server grants and
does not resume a previous controller or input operation.

Tests combine the actual companion transport/controller with synthetic local
hosts to cover heartbeat during prompts, late selection, network loss, declined
request replay, active local stop, blocked cleanup and startup failures. Windows
CI runs the same lifecycle tests. No native input occurs in these tests.

The installed Windows CLI supplies the connection task described below. Other
platforms remain presence-only. Interactive Windows qualification and private
routing are still required before production activation.

## Companion command transport

The installed Windows CLI connects this command client to local consent and the private server queue. Each request still requires a live manual Chat run and a separate local window approval; pairing alone cannot start capture or input.

An accepted controller exposes only its access ID, connection generation and opaque target ID. The outbound client claims one command, validates every binding and admits only observation, click or literal text. A command has at most ten seconds, measured conservatively from the start of its claim request. Local consent, OS readiness, one-use observations and the short server permits continue to gate every native operation.

Commands run sequentially. The client retains every seen command ID for the session, with a hard ceiling of 1,024 and no eviction. Duplicate IDs, stale claims, malformed responses and uncertain acknowledgements retire the session. No claim, input or result request is automatically retried. The server also claims each durable command once; this local replay fence supplements the database guarantee.

Only command claims admit up to 32 KiB of response JSON for escaped literal text; other response limits stay at 4 KiB. Result uploads admit up to 3 MiB, while ordinary request bodies stay at 2 KiB. An observation must contain one inline PNG/JPEG, pass the shared runtime image limits and match its declared dimensions. Completion uploads omit the original input text. No screenshot, input text or native target is logged by this transport.

Local stop or an operation timeout cancels outstanding work. Late captures are discarded. The loop awaits controller cleanup before settling; unconfirmed cleanup remains terminal. A lost input acknowledgement must be reconciled as unknown by the server, never inferred as failure or replayed. The protocol is private machine traffic and adds no PC listener or public dashboard route.

## Durable private command queue

The producer requires a live executor lease and a committed `running` receipt for `mira_computer_observe` or `mira_computer_input`. The receipt ID becomes the immutable command ID. The server selects the active consented target for that run; model arguments cannot supply an owner, lease, connection, native window or executable. Only trusted server code can enqueue; no browser or machine endpoint produces commands yet.

`commands/claim` and `commands/finish` are available only on the separately configured private computer listener. Device credentials, exact access/generation/target binding, account controls, worker leases and tool receipt state are rechecked. A claim atomically removes its stored input payload, and cannot be repeated. Completion is accepted once. Authorized consumption returns the result once and clears it in the same transaction. A lost claim, acknowledgement or consumption is never replayed.

Commands expire after at most fifteen seconds from admission and at most ten seconds from claim. Expired queued work is refused; expired or revoked dispatched work becomes unknown. Both clear content and retire that access. Human/local stop, reconnect, device revocation and conversation deletion erase outstanding content immediately. Periodic resource cleanup handles expiry, worker loss and pauses even while the model provider is unavailable. Expiry also denies fresh PC permits before cleanup runs; the existing local permit and operation deadlines remain mandatory.

Storage is bounded to one outstanding command per access, eight per account and thirty-two globally, with at most thirty-two commands over a single access lifetime. If cleanup stops, admission fails at capacity. Replay tombstones contain no input or image payload. Observation results reuse the runtime image validation and dimension checks. Only completion uploads admit up to 3 MiB; other private request bodies keep the 2 KiB limit and all requests retain the concurrency/deadline bounds. No command data is copied to audit logs.

## Executor visual tools

Manual runs expose `mira_computer_observe` and `mira_computer_input` through the ordinary durable tool receipt router. The committed receipt ID is passed only in trusted service context. Model arguments cannot choose a computer, grant, owner, lease or window, request access or accept local consent. Automated runs cannot use either tool. There is no model-owned shell or general desktop API.

Observation returns validated inline image content plus generated observation ID and native pixel dimensions, rather than base64 inside JSON text. The runtime image helper displays that content. Screen content is untrusted data. Input requires a fresh one-use observation and preserves confirmed, partial, unverified and refused outcomes. Unknown delivery is never retried or described as a rollback.

The executor polls for at most fifteen seconds without holding a transaction open. Cancellation, uncertain delivery, lost consumption, invalid results or receipt-finalization failure stop the exact grant and erase outstanding command content. Final disclosure locks the same account controls and live run, checks the consumed command deadline and current access, and commits receipt success before releasing the result. A human stop that wins that fence discards the image. Repeated call IDs remain blocked across recreated tool routers.

Integration tests use a disposable database and synthetic frames to qualify this complete producer/consumer/result path, including cancellation before/after dispatch, stopped access after consumption and failed final receipt commits. They do not capture or control a real desktop. The installed Windows CLI composes these tools with local approval. Private-session and interactive Windows qualification remain required before live activation.

## Chat access controls

Chat exposes Computer access from the composer and conversation menu. During a running manual request, the operator selects a connected PC and View only (the default) or Control. The existing human verification flow protects the request. The paired companion must separately ask the operator to select and allow one local window. Chat cannot perform that local approval.

The model can use `mira_computer_wait` to read its own run's readiness or wait at most 60 seconds while the operator decides. This tool is read-only, unavailable to automations and incapable of requesting, approving or renewing access. Cancellation ends the wait without recording an uncertain input action. All observation/input commands still enforce the independent server and local authority checks.

The status strip and dialog offer Stop access without requiring another verification. Failed or old status reads show unavailable status while retaining an existing stop action. Device selections pin the displayed version, and switching runs clears the selection. Dialogs use the shared bounded, scrollable modal; narrow layouts stack full-width actions.

The disposable Mira preview includes a synthetic waiting conversation for layout review. Its computer metadata never connects to a real companion. The installed Windows composition is described below. Release distribution and live interactive qualification remain separate delivery work.

## Installed Windows composition

`bun run build:computer:windows C:\absolute\build-root` builds the desktop manager, companion,
consent window, worker supervisor and unchanged locked native dependencies together
in `build-root/windows-x64`. That subdirectory must be absent or empty. Existing
packages are never replaced. The build does not install, start, pair or update a PC.
The standalone `build:computer windows-x64` command builds only the entrypoint and
is insufficient for Windows `run`.

The installed `mira-computer.exe run https://private.example.test` validates all
four fixed sibling executables before reading the OS vault or connecting. Renamed,
missing, directory, linked and network-share executable paths are refused. Windows
volume checks reject mapped remote drives as well as UNC paths; ordinary case
variations and 8.3 spelling are canonicalized without allowing linked paths. Native
processes use the package directory and a filtered OS environment, independent of
the current working directory. Package integrity and authenticated distribution
remain release requirements; this does not protect against another process that
can rewrite the same user's installed files.

Each presence generation runs the existing consent loop and then the sequential
command loop. No native process starts while the client merely waits for a Chat
request. A request opens the local consent window, which requires an explicit
selection and Allow. Only successful local consent, server acceptance and current
readiness permits can start the supervised worker. View-only consent cannot send
input. Ctrl+C, local Stop, expiry or network loss retire the generation and join
native cleanup before replacement; uncertain input is never replayed. Unconfirmed
cleanup is terminal. A temporary command-polling outage may reconnect only after
confirmed cleanup; failed input/result delivery remains terminal. No PC listener
or public endpoint is added.

The Windows qualification builds the complete package and verifies its compiled
help/version and missing-sibling refusal from an unrelated working directory.
Cross-platform synthetic tests exercise the actual connection-work composition,
including heartbeat during consent, refusal, serial image/input transport, network
loss and cleanup failure. These tests do not grant access to the operator's desktop.

## Qualified Windows release archive

`bun run test:computer:windows-worker [absolute-export-directory]` builds the
complete Windows x64 package with the pinned Bun and SDK, inventories its files,
creates a ZIP with the operating system's .NET compression library, and extracts
that freshly built archive into an isolated directory. Native qualification runs
against the extracted executables and libraries, including startup/cleanup and
missing-library refusal. The original and extracted trees must have exactly the
same paths, lengths and SHA-256 hashes. Export occurs only after qualification
succeeds. No real window is captured or controlled by this test.

Stable Homelab releases attach `mira-computer-<version>-windows-x64.zip` and the
matching `.json` manifest. The existing release workflow reuses the Windows
artifact from its successful CI invocation; it does not rebuild the published
package. Publication additionally waits for source-version/ancestry validation
and the release image tests. PRs have no release-write permission. Retries accept
identical existing assets and refuse to replace different bytes. A failed partial
upload is not a complete distribution: both assets and the exact archive hash
must match before use.

The bounded manifest records the source revision, Homelab/Bun/driver versions,
platform, archive digest and complete file inventory. It rejects Windows path
aliases, traversal, reserved names, duplicate/conflicting paths, missing entrypoints
and oversized packages. The file inventory is integrity evidence, not a digital
signature or publisher authentication. Obtain artifacts only from the verified
Homelab release; these executables are not Authenticode-signed. The build-time ZIP
round-trip only reads its own fresh output and is not an untrusted archive
installer.

The per-user installer and Settings download flow are described below. Rollback,
interactive Windows acceptance and private routing qualification
remain separate work before PC activation. No installation, autostart entry, pairing, credential
or network configuration is changed by building or publishing an archive.

## Windows connection window and system tray

Open `mira-computer-desktop.exe` from the complete local package in a normal,
non-administrator Windows session. Enter the private HTTPS server address and the
single-use pairing code from Settings > Computers, then select Pair computer.
The code is hidden, sent through a private pipe and never stored in preferences
or command arguments. Credentials remain in the existing Windows vault. Only
the server address is saved in `%LOCALAPPDATA%\Homelab\MiraComputer\server.txt`.
Pairing does not automatically connect or grant window access.

Connect starts the companion; Stop ends the connection and any owned native
processes. Minimizing hides the window in the system tray without disconnecting.
The tray uses the shared Homelab icon, shows connection status in its tooltip,
and offers Open Mira, Stop connection and Exit. Double-click restores the window.
Closing the window or choosing Exit stops the connection before exiting.
Session changes, suspension and resume also stop the connection; reconnecting
requires the operator to select Connect again. Every Chat request still requires
separate local window approval. Optional startup at sign-in uses the installer task
below; there is no PC listener or new public route.

The manager owns the companion and its descendants in a Windows Job Object.
It first closes the private input pipe to request the existing controller's
graceful cleanup, then enforces bounded process-tree termination. If the manager
crashes, kill-on-close retires the same tree. Cleanup that cannot be confirmed
blocks another connection in that manager. One manager is allowed per Windows
account. Remove pairing deletes the local vault entry; use Settings to revoke
server access too. A failed or cancelled pairing must be revoked before retrying.

`bun run test:computer:windows-desktop` builds native isolated fixtures and checks
argument quoting, private pairing input, settings validation, graceful stop,
unresponsive children, nested process ownership, manager death and malformed
output. CI also checks the actual extracted desktop executable and its
missing-sibling refusal. These checks do not capture or control a real desktop;
interactive Windows acceptance and private Meshnet routing remain required.

## Per-user Windows installer

Stable releases also attach `mira-computer-<version>-windows-x64-setup.exe`, built
from the same verified payload as the ZIP. It installs into the current user's
`%LOCALAPPDATA%\Programs\Homelab\MiraComputer`, creates a Start-menu shortcut and
registers a normal per-user uninstaller. It does not request elevation, enroll a
computer or start a connection during installation. Startup at sign-in is an
explicit, initially unchecked task. The installer uses the shared
Homelab icon and the standard dark Inno Setup wizard.

Exit Mira from its tray menu and stop command-line clients before installation,
upgrade or uninstall. The desktop and packaged CLI hold a shared installation
lease; maintenance holds an exclusive handle to the same per-user file throughout
its work. CLI cancellation retains its lease until controller cleanup completes.
The installer neither force-closes processes nor schedules replacements on reboot.
New versions use separate payload directories. Reinstalling the same version
accepts only byte-identical existing files; altered files or unexpected additions
require uninstalling first. Program directories cannot be linked or network paths.
Uninstall removes the logged program files and shortcuts, while retaining user
preferences and the OS-vault pairing. Use Forget pairing and Settings > Computers

> Revoke when retiring a computer.

The compiler version, official release URL, SHA-256 and Authenticode publisher are
pinned in `deploy/computer/inno.json`. `scripts/setupInno.ps1` verifies the download
and extracts it in portable mode into a new caller-owned directory. Compiler
updates require a reviewed pin change and the same Windows qualification; Inno is
a build dependency, not an installed Mira runtime dependency.

CI builds the setup executable from the already qualified extracted archive, then
uses a disposable GitHub-hosted Windows runner to test fresh installation, repair,
busy upgrade/uninstall refusal, changed/extra file rejection, versioned upgrade,
shortcut targeting and uninstall without deleting user state. Only the tested
setup executable and matching manifest digest join the release assets. These
installation tests refuse to run on developer PCs. The setup asset is currently
unsigned; a matching manifest hash verifies bytes, not publisher authenticity.
Download it only from the authenticated Homelab GitHub release. Automated update
selection/authentication and live private-network acceptance
remain separate delivery work.

### Windows downloads in Settings

The existing `homelab.release` worker check also reads the Windows installer metadata.
It requires the stable tag and commit already verified for the container release, a
successful `container-images.yml` release workflow, and an unexpired raw Windows
manifest artifact from that exact workflow attempt. The installer name, size and
GitHub-reported digest must match that manifest. Legacy releases and incomplete or
changed Windows assets leave downloads unavailable without invalidating container
reporting.

Settings → Computers offers **Download Windows** only while that snapshot is fresh
(20 minutes), belongs to the configured repository, and no newer check has failed.
The button is an ordinary official GitHub release download; it does not verify the
browser's downloaded bytes or install software. Windows x64 on Windows 10 or later
is required. Run the per-user installer and then pair the computer. For a manual
upgrade, exit Mira, run the newer installer and reopen Mira; pairing is retained.
The Windows app also offers the authenticated update flow below. Recovery to a retained older installation remains a manual operation.

A paired Windows computer with a lower stable version shows **Update available**.
Unknown, prerelease or newer local versions are not called outdated. Each authenticated
connection refreshes the self-reported version; this is inventory information, not
attestation or permission to control the computer. Legacy connections without a
version clear the old enrollment version rather than misleadingly retaining it.
Release downloads do not add a listener, change private routing or grant input access.

### Authenticated Windows update transport

The private machine listener exposes `POST /api/mira/computers/update` only to a
live paired device credential. It returns the existing worker's fresh verified
Windows release identity, hash and size, with at most five minutes of validity.
It does not return an arbitrary download URL, accept browser credentials, create a
connection generation or authorize computer control. The public dashboard returns
404 for this route, as for other computer machine endpoints.

`ComputerCompanion.update` reads that receipt from the pinned private HTTPS origin.
`withComputerUpdate` accepts only a newer stable version, derives the official
GitHub asset URL, follows at most three redirects to the fixed GitHub storage
hosts, and never sends pairing or GitHub credentials to those hosts. The download
is bounded by its declared size (maximum 512 MiB), freshness and a five-minute
ceiling. It verifies SHA-256 while streaming and again from the staged file, then
requires the same release to be authorized by the private server after download.
Revocation, stale or changed evidence, unexpected redirects and incomplete/changed
bytes prevent the local consumer from receiving an installer.

Each operation owns a unique temporary directory. The trusted consumer must wait
for all uses of the file to stop; completion, cancellation and errors remove the
staging directory. The download deadline is not allowed to terminate an installer
mid-write. This transport does not launch installers or expose a model tool. Native
update UI and installation handoff are described below; rollback qualification remains separate work.

### Updating in the Windows app

Stop the connection, then select **Update app**. The launcher downloads the newer
verified stable release using the existing private pairing. **Stop** or closing
Mira cancels the download. No update creates a connection or approves a window.

The companion transfers a bounded metadata line and exact installer bytes over
its private launcher pipe, never a credential, URL or local path. The launcher
verifies its own copy and keeps a native read handle that denies modification
and deletion. It requires clean download-process exit and unexpired evidence
before releasing its installation lease. Other running Mira command-line clients
still prevent installation.

After setup starts, Stop/close cannot terminate it mid-write. A separate installer
job waits for all descendants, with no kill-on-owner-close policy; ordinary
connection and download workers retain their existing kill-on-close protection.
The per-user installer keeps pairing and preferences. After successful completion,
Mira asks you to reopen it from the updated Start-menu shortcut. It does not
silently reconnect or grant input access. An unconfirmed installer outcome blocks
new work in the old launcher; let setup finish before reopening Mira.

The hosted Windows qualification performs an actual upgrade through this native
copy/verification/installer path. Local tests use harmless fixture executables,
including broken pipes, incorrect bytes, cancellation and installer descendants.

### Optional startup at sign-in

The per-user installer offers **Start Mira in the tray and connect when I sign in**,
unchecked on a new installation. Opting in adds only the current user's startup
shortcut. It starts the qualified desktop manager with `--startup`, uses the saved
private server and OS-vault pairing, and stays in the tray. If no server is configured,
it remains disconnected. Startup never enrolls the computer or approves a window.

Automatic upgrades preserve the selected task and update the shortcut to the new
immutable version. Run the installer again and uncheck the startup task to remove
it; uninstall also removes the shortcut. Standard [Inno Setup task persistence](https://jrsoftware.org/ishelp/topic_setup_useprevioustasks.htm)
keeps this choice with the per-user installation. No Windows service, elevated
scheduled task, new listener or extra credential file is installed.

## Windows window capture and element input

Windows view and control sessions use the packaged `mira-window-capture.exe`. The local
consent host supplies the selected process creation time alongside the immutable
executable, PID and HWND. Each capture rechecks that identity and the interactive
session, refuses minimized or closed targets, and uses only Windows Graphics
Capture `CreateForWindow`. It has no desktop, screen-region or GDI fallback.
The SDK supplies the selected window's accessibility tree with screenshots disabled.

The helper crops invisible resize margins from known whole-window WGC surfaces
to physical DWM frame bounds with a one-pixel inset, matching the existing window
coordinate convention. Unknown origins are refused. Raw PNGs are capped at 1792
KiB so Base64 plus the worst-case escaped accessibility tree fits both private
transport envelopes. Changed bounds, unsupported capture, timeouts,
excessive frames and invalid or incomplete PNGs fail without exporting pixels. A
missing helper fails package validation before pairing. The helper inherits the
worker's Windows process job; Stop aborts a pending capture and cleanup waits for
its exit. View-only policy and the adapter both refuse input.

The hosted qualification covers the independent cyan target behind a magenta cover,
including the extracted package's complete view-only worker path. Fixed and
resizable windows use independently measured frame bounds and colored markers
to check the exact crop origin. It independently
decodes the PNG and verifies that a closed target is refused while its owner stays
alive. Existing Windows input, installer, package inventory and process-ownership
tests remain required. No screenshots are logged, uploaded or retained.

Control mode uses the same WGC-only image path and the unmodified SDK's public
`ClickPosition.Element` interface. The private worker accepts only tokens from its
last observed, non-degraded tree; the outer session also checks exact membership,
the ten-second deadline and one-use observation identity. Any input consumes the
native token set. Windows coordinate clicks are refused before SDK dispatch, with
no fallback to the SDK's screen-region screenshot path. Custom canvas controls
without accessibility elements are therefore not clickable yet. Literal typing
retains the host-selected delivery mode and exact window target.

The hosted Windows package qualification clicks the entry and counter using their
actual observed tokens, independently verifies text and one increment, and refuses
coordinate input and a token from an older observation. The durable transport
accepts bounded role/label/token metadata while rejecting arbitrary tree text;
labels remain untrusted content. Lock/browser acceptance and private-network
activation remain required before deployment. No local SDK patch is used.

The new helper requires Windows 10 version 2004 or later for cursor-free capture.
Microsoft API references: [CreateForWindow](https://learn.microsoft.com/en-us/windows/win32/api/windows.graphics.capture.interop/nf-windows-graphics-capture-interop-igraphicscaptureiteminterop-createforwindow)
and [CreateFreeThreaded](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.direct3d11captureframepool.createfreethreaded).

## Hosted Windows consent interruption acceptance

`bun run test:computer:windows-acceptance` refuses developer PCs and runs only on
a disposable GitHub-hosted Windows runner. It builds the actual consent binary
and a separate, non-distributed acceptance harness. GitHub's hosted Windows account
is elevated with UAC disabled, so the harness creates one random local standard test
account and verifies its non-elevated token before starting any acceptance. Its
random password stays only in memory and is never passed to children or logs. The
account receives read/execute access only to the owned test package, a writable
scratch directory and temporary GUI access on the disposable runner. Both original
desktop DACLs are restored and the account is removed after the child exits. The
harness does not load a user profile or change UAC policy. The production
administrator-window refusal remains intact.
Windows UI Automation selects
only the harness-owned fixture in the consent window, verifies that foreground
control needs the unchecked checkbox, and checks the selected process/window
identity against the fixture's independent pipe. It does not capture pixels.

The test proves local Stop, parent pipe loss and target exit each produce one
terminal stop receipt followed by native process exit. Its final case invokes
[LockWorkStation](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-lockworkstation),
waits for independent desktop refusal and the consent host's stop receipt, and
requires a new consent host to refuse initialization while locked. Merely accepting
the asynchronous lock request is not considered proof. The runner remains locked;
this test owns a separate CI job and runs lock last. No unlock or user credential
is attempted. Sleep/resume, reconnect and operator-PC acceptance remain separate
from this lock qualification. Existing transport cancellation tests still cover
late results and unknown input after connection loss.

## Private transport reconnect acceptance

The PostgreSQL integration suite runs the actual companion presence, consent and
command loops against the production machine receiver over certificate-verified
loopback HTTPS. Only the local window host is synthetic: these checks never touch
an operator desktop. Each case owns a disposable database and ephemeral TLS key.

The receiver commits a command claim or input completion, then the test closes
the real listening socket before returning its response. A lost claim must wait
for local driver cleanup before reconnecting. The new generation rejects old
heartbeats and late results, erases transient command content and requires a new
access request plus explicit local consent before fresh input can run. An input
whose completion acknowledgement was lost remains terminal, even when the native
fixture and server already completed it; it must not retry the input or reconnect
automatically. Restarting presence cannot revive that command.

This qualifies the private transport and durable queue together, not Windows
session disconnect/reconnect, suspend/resume or the deployed Meshnet route.
