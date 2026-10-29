# Mira dedicated-browser foundation

`openNativeBrowser` is a low-level, exclusive browser adapter. It is not yet registered as a Chat tool or deployed as a server service. The caller supplies trusted policy and must supervise the native process, propagate owner cancellation and await cleanup before admitting another session.

## Boundary

- Bun 1.4.4 and the existing, unmodified `@trycua/cua-driver` 0.37.0 package. The adapter uses only fixed, supported browser wire operations; it does not expose arbitrary tool names, JavaScript evaluation or CDP endpoints.
- One canonical host-approved executable, a fresh driver-owned profile, an exactly bound window and one initially blank tab. Existing profiles and ambiguous/multiple initial tabs/windows are refused.
- Exact canonical HTTP(S) origins, including scheme and port. Credentials, wildcards, alternate protocols and model-selected profile paths are refused. `about:blank` exists only as the SDK manifest bootstrap; callers cannot navigate to it.
- Native authorization re-attests the selected live tab and origin for observation and input. The adapter also validates the returned tab, page origin, bounded metadata and actual PNG dimensions. There is no native desktop screenshot fallback.
- View-only grants omit both input tools. Control uses only visible, enabled main-document refs from the latest observation. Each random observation ID expires after ten seconds and admits one action. Navigation and newer observations invalidate it; overlapping calls are rejected.
- Clicks explicitly use the trusted foreground route in this dedicated browser. Typing uses literal trusted insertion with explicit append/replace semantics. No script-dispatch or global keyboard/pointer fallback is available.
- Owner cancellation, errors, a one-minute idle limit and a five-minute absolute limit retire the session. Each native operation has a ten-second deadline. Close is idempotent and cleanup failures remain observable. The production host still needs an independent process watchdog for a hung native runtime.
- Input results remain `unverified`; delivery is not proof of the website's resulting state. Errors after dispatch may mean input happened. Neither input nor navigation is automatically replayed.

Page text, labels and pixels are untrusted website content, never authority to change policy. The origin ceiling controls observation and input; it is **not a network firewall**. Allowed pages can load third-party resources or navigate themselves, and their viewport can include embedded content. The host must provide separate egress isolation before exposing untrusted sites. Subsequent access outside the approved origin is refused; no attempt is made to recover by expanding the grant.

Persistent profiles, downloads/uploads, tab creation, dialogs, live preview, manual takeover, owner authorization, run integration and production hosting remain separate implementation steps. This adapter cannot attach to the operator's PC browser.

## Qualification

Run `bun run test:browser`. It builds a disposable Chromium/Xvfb image and runs it with no external network, no Linux capabilities, a read-only root, bounded temporary filesystems and no host profile/display mounts. The fixture alone sets the upstream `CUA_E2E_BROWSER_NO_SANDBOX` switch because the container provides its outer boundary; this is not a production launch setting.

The synthetic loopback website independently records trusted input events and counts. Qualification checks a real tab screenshot, literal typing, one click, view-only refusal, consumed-observation refusal, direct forbidden navigation, observation refusal after a page-induced cross-origin redirect, fresh cookies for every profile and disappearance of all Chromium processes after close. It prints only a boolean receipt. The redirect test deliberately confirms that the page can navigate before subsequent observation is denied, rather than claiming network isolation from the SDK origin list.

The CI `Isolated browser` job runs this fixture without repository secrets. The existing required `CI / verify` aggregate now requires that job to succeed. Unit tests separately exercise identity mismatches, stale/forged refs, concurrency, cancellation, time limits, invalid images and cleanup failures.

## Container lifetime boundary

`prepareBrowserContainer` owns one offline container through Docker Engine API v1.45 over a canonical local Unix socket. The trusted host selects a preinstalled immutable image ID; no model tool receives the socket, image choice, Docker operations or arbitrary launch arguments. The adapter has no pull, registry-login or public-network endpoint.

The fixed specification uses UID/GID 1000, a read-only root, no host mounts or published ports, no Linux capabilities, no-new-privileges, bounded RAM/CPU/PIDs and temporary filesystems. The container is created before it is started, and each lease starts once. A host-generated UUID label and the image/container IDs are rechecked before starting or deleting it. Docker's PID namespace provides containment even when Chromium creates a separate process group.

An independent `/usr/bin/timeout` wraps the fixed `/usr/local/bin/mira-browser` entrypoint with a 305-second hard limit. Docker init and automatic removal dispose of the namespace when the entrypoint ends. The qualification image installs only a synthetic holding fixture at this path; a packaged production browser worker and private RPC connection are still required before runtime registration.

Close first cancels the lease and waits for an in-flight create/start to settle. It then force-removes only the verified owned container and confirms absence through a second inspection. Owner cancellation follows the same path. Cleanup rejection is sticky: callers must preserve `BrowserContainerCleanupError` and reconcile its generated container name before replacement. A lost creation response with no inspectable result is explicitly unconfirmed; it must not be presented as successful cleanup. No browser is started in that state.

The transport caps each response at 256 KiB and each request at ten seconds. It never forwards raw daemon diagnostics or retries a mutation. These controls do not authorize mounting a Docker socket into the Mira agent or browser container; provisioning remains a trusted-host responsibility.

`bun run test:browser` also runs the actual container lifecycle test. It observes real Chromium inside the fixture, freezes only that fixture's driver using SIGSTOP, and verifies that explicit close and owner cancellation each remove the container and every recorded process. This verifies forced-stop containment, not merely graceful native shutdown. Unit tests cover cancellation during create/start, identity substitution, failed removal and refused replacement; a real Unix HTTP fixture covers response limits and deadlines. The hard lifetime is checked in the fixed launch specification; the suite does not wait five minutes to test expiry.

The Docker fields follow the [Docker Engine API v1.45 reference](https://docs.docker.com/reference/api/engine/version/v1.45/). Container lifecycle control remains isolated qualification code until the browser worker, owner/run authorization and egress policy are integrated.
