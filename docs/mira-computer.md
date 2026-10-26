# Mira computer driver

The computer foundation uses the unmodified, pinned `@trycua/cua-driver` 0.37.0 SDK with Bun 1.4.4. It provides a single-window adapter and a reproducible native X11 qualification. It is not registered as a Chat tool or deployed on a user's desktop yet.

## Authority and observations

The host supplies a canonical executable, PID, native window ID and explicit `background` or `foreground` delivery mode. Model input cannot choose these values. A v3 bounded capability manifest allows only `get_window_state`, `click` and `type_text` for that executable, with desktop capture disabled. The adapter further fixes every request to the chosen PID/window. Driver authority expires after five minutes or one idle minute. Browser origins require a separate browser-only runtime; this native application grant does not provide origin isolation.

`ComputerWindowSession` takes a trusted availability callback. Its eventual host must check the current owner/run lease, local stop, pauses, connection generation and interactive OS desktop state before each call and before returning results. The driver's `desktopUnlocked` and `desktopCaptureAuthorized` fields report capture permission, **not** Windows lock state. A paired Windows companion must run in the user's interactive session and supply an independently qualified lock/sleep/disconnect check.

Each observation has one random identifier, expires after ten monotonic seconds and permits at most one input. A new observation invalidates the previous one. Overlapping calls are refused. Coordinates must fall within the observed native-resolution image; the native driver receives window-local coordinates, not desktop coordinates. No screenshot file paths or remote image URLs are read. PNG/JPEG data uses the same size, signature and dimension validation as Mira's runtime image transport. Partial accessibility trees are labelled incomplete, while a valid pixel frame remains usable.

Input never automatically changes delivery mode or retries. Driver effects remain `confirmed`, `partial`, `unverified`, `refused` or `unknown`. A resolved native call is not proof that the application changed. Errors or cancellations after dispatch are conservatively `unknown` and retire the session. Local stop immediately blocks new calls, aborts admitted calls and releases the native runtime. The host still needs a supervised process boundary for hard deadlines; native cleanup alone is not a process kill mechanism.

The SDK's typed `TypeTextInput` currently omits `delivery_mode`. The adapter uses the official wire schema for the fixed `type_text` call with a host-fixed target and delivery mode. It exposes no generic tool execution, shell, launcher, clipboard, filesystem or permission-changing endpoint. Native `snapshotId` values are not capture IDs; the adapter does not substitute them into `CapturedCoordinates`.

## Repeatable qualification

Run `bun run test:computer` on a Docker-capable development host. The command builds the repository's fixture image and runs it with no network, no host desktop/device mounts, no capabilities, no elevated privileges and a read-only filesystem with bounded temporary storage. The SDK remains an ordinary repository dependency, covered by lockfile and dependency updates; the disposable image is not a new deployed service.

The image starts Xvfb, Openbox and a synthetic Tk window, waiting for the display, window manager and visible application before publishing readiness. The qualification reads an inline image, focuses the entry, types a literal string and clicks a counter. It verifies the text and exactly one increment through the fixture's separate state file. It also checks denied desktop discovery, denied out-of-manifest executable access, one-use observations and closed-session refusal. It prints only a content-free receipt. CI runs the same command in the existing secret-free source-verification job.

Unit tests cover scope validation, stale/superseded/cross-session observations, out-of-bounds input, overlapping calls, host revocation, cancellation, unknown results, malformed frames, native cleanup and exact fixed-tool request mapping.

Passing this fixture qualifies Linux X11 with explicit foreground input. It does not qualify Windows, Wayland, browser origin handling, background keyboard input, OS lock detection or production computer access. Remaining delivery work includes a supervised companion, outbound pairing, session grants, stop/takeover/revoke controls, Windows/browser acceptance and updater integration for the deployed companion artifact.

Upstream references: [SDK](https://cua.ai/docs/cua-driver/guides/use-the-sdk), [permission manifests](https://cua.ai/docs/cua-driver/guides/permissions), [platform limits](https://cua.ai/docs/cua-driver/concepts/platform-support).
