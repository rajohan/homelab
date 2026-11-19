# Mira server browser

In manual Chat, Mira starts the server browser for requested work without a separate website list or browser approval. Navigation, clicking and typing use the same task session. On a connected host, it reaches internet pages, home services and development previews together. Chat shows a compact browser row only while a session exists, with View browser, takeover and Stop browser. There is no startup URL form, grant icon or profile selector in the composer. The browser remains an isolated Chromium process with no PC profile, host files or Docker socket.

## Combined network access

The server selects the configured network; the operator does not choose Internet or Home network for ordinary browsing. Public CDNs and sign-in providers can load alongside internal services. Destinations must be reachable from Main and website authentication still applies. Account pauses, manual-run leases, human takeover and operator stop remain effective. A stopped session is not reopened automatically. Ordinary browsing lasts while its manual run remains active, until Mira closes it or the operator stops it; there is no fixed wall-clock session limit. Thinking between actions does not close it. The host checks authority at least once per second, including while idle. The same lifetime applies to Mira's dedicated saved profile. Legacy exact-site sessions are no longer admitted by the browser worker. Website content cannot authorize unrelated actions, sending, purchases or publication.

Legacy saved sign-ins retain their exact website and network scope. Mira's dedicated profile is created separately for the server-selected network scope; old profiles are never broadened. Old connected grants are retired instead of silently acquiring the expanded route. New temporary sessions use the combined network automatically; this does not enable paused automations or connect an unconfigured home network.

Install the optional `deploy/compose.browser-network.yaml` after the other Compose files. Set `HOMELAB_MIRA_BROWSER_NETWORK_OWNER` to the operator account, `HOMELAB_MIRA_BROWSER_DNS` to the private IPv4 resolver, and `HOMELAB_MIRA_BROWSER_LAN_V4` and `HOMELAB_MIRA_BROWSER_LAN_V6` to the routed IPv4 and ULA prefixes. In the private host JSON mark browser slot A with `"network": "internet"` and B with `"network": "connected"`, each bound to its own verified proxy. Recreate the affected services. The code runner retains its original public-only proxy. No new inbound ports are published.

The connected proxy permits HTTP(S) traffic to the configured home networks and internet in one session. DNS answers are pinned for the session. Non-web infrastructure ports, link-local metadata and container management interfaces remain outside browser access. The code runner keeps its independent public-only proxy. Remove the overlay, account binding and network markers together to return to the original public-only setup.

The connected outbound bridge has explicit IPAM so its gateway survives network recreation. The defaults are `172.26.0.0/16` with gateway `172.26.0.1` and `fd55:d90d:e31d:1::/64` with gateway `fd55:d90d:e31d:1::1`. The IPv4 gateway uses `HOMELAB_MIRA_BROWSER_DEV_HOST` when configured. Override `HOMELAB_MIRA_BROWSER_OUTBOUND_SUBNET`, `HOMELAB_MIRA_BROWSER_OUTBOUND_SUBNET_V6` and `HOMELAB_MIRA_BROWSER_OUTBOUND_GATEWAY_V6` through the existing deployment environment if the host uses different ranges. Check host/VPN/Docker overlap before activation. On an existing installation, preserve both current subnet/gateway pairs, back up the installed Compose file, drain the browser host and stop both proxy service supervisors before recreating this network. Verify both proxies, their bound container IDs, internet/LAN routing and the development gateway before restarting the browser host. A Compose dry-run is required: even matching addresses can cause network recreation because its configuration hash changes. Do not restart unrelated services or remove other networks.

For development on Main, optionally set `HOMELAB_MIRA_BROWSER_DEV_HOST` to the gateway IPv4 address of the proxy's outbound Docker bridge. The connected proxy resolves `localhost` to that gateway only for ports 3100, 3101 and 8400. Run `bun run dev --live --browser-host=<gateway>` in the development checkout. The existing disposable dev process forwards these three ports from that bridge to its loopback listeners and removes them on exit. It rejects LAN and wildcard bindings. No production identity data or additional permanent service is used.

## Interactive Chromium

**View browser** opens a live Chromium window inside Chat. **Take control** enables direct mouse, keyboard and scrolling. Chromium supplies its own address bar, back/forward navigation, menus and tabs. **Return to Mira** hands control back; closing the viewer alone does not do so. The old screenshot refresh, element picker and text-entry forms are removed. The viewer keeps its connecting state until the first framebuffer arrives and offers explicit reconnection after a disconnect; input is never replayed.

The shared React viewer uses the root-pinned noVNC client. It connects to the dashboard's same-origin WebSocket through the existing signed-in identity. The dashboard rechecks central identity throughout the connection and never receives the Docker socket. The browser host accepts display routing over a mode-0600 Unix socket in the existing shared attachment directory, checks owner, process, run lease and controller generation, and attaches a fixed x11vnc process to the existing Chromium display. A small Python standard-library relay gives inetd the duplex socket it requires; there is no VNC TCP port, public CDP endpoint, new service, credential or environment variable.

View-only is enforced by x11vnc as well as the web client. Handover closes the previous input process and confirms its exit before model dispatch; the host checks again after command claim while control changes are excluded. Previous model observations are invalidated after human input. Account pause, run cancellation, session logout and operator stop close the display connection. The browser itself has no fixed wall-clock limit.

Websites and development are the primary use. The viewport carries video frames but no audio stream. A YubiKey attached to the operator's PC is not forwarded to server Chromium; that requires a future separate connection.

## Browser tabs

The operator uses Chromium's native tab bar. Mira uses `mira_browser_tabs` with the IDs from its latest observation. The worker reconciles tabs opened, closed or selected in Chromium before observing. Model observations contain at most eight web tabs including the selected one, and model tab creation stops at eight. Native new-tab pages are not model targets; open an HTTP(S) page before returning control. Saved profiles retain site data, not the previous tab list.

**Deployment is explicit and independent of the account switch.** Configured sessions use the existing isolated Docker slots and verified Squid/nft proxies. Provision and verify the live host before enabling the account switch. A website scope is not a network firewall.

## Operator controls and run lifetime

- The independent `computer:browser` switch defaults off. Manage it in **Automations → Browser**. Pausing it stops current sessions and blocks new sessions; it does not pause unrelated tools.
- `mira_browser_open` starts a requested task directly. Mira chooses `profile: "saved"` (the default dedicated account profile) or `profile: "temporary"` (fresh storage). Only active manual runs can start or use a browser. Website content never supplies authority.
- `mira_browser_close` revokes this run's session when the task is finished. Human Stop browser and human takeover remain available in Chat. Closing the viewer alone does not stop the session or return control.
- New broad sessions store no fixed `expires_at`. Every action and the idle host supervisor recheck the current run lease, cancellation, account switch, control generation and any run budget. The supervisor renews at least once per second and fails closed within its short authority lease if checking stalls. Run completion/disconnection retires access and triggers ordinary host recovery; removing the wall-clock deadline does not remove crash cleanup.
- One unclosed session per account and existing process/storage quotas remain in force. Unknown outcomes are never replayed. The host confirms container removal before releasing capacity.
- Login to dedicated Mira or development accounts is permitted only with credentials explicitly made available for the requested work. Password values are excluded from outlines; the model cannot inspect the operator's PC browser or extract saved passwords. MFA, passkeys, permission grants and security approvals on the operator's behalf remain human actions.

## Durable command delivery

`mira_browser_commands` binds each command to a server-reserved tool receipt, owner, run lease and human grant. The host claims it once for the exact durable process/controller generation. A claimed command is never reclaimed or replayed. Browser startup can consume up to sixty seconds; queued commands expire within one hundred seconds and claimed commands within twenty-five seconds. At most one outstanding command per grant, sixty-four commands per grant and thirty-two outstanding globally bound content and work.

Each stage checks the live run, tool receipt, grant scope, process generation and deadlines. Result completion, one-time consumption and final model disclosure remain separately fenced. Images, dimensions, URL origins and element references are validated before delivery. Result content is erased on consumption, cancellation, expiry and conversation deletion; content-free tombstones prevent replay. Provider-independent cleanup also runs in the ordinary Mira executor if the browser host is unavailable.

Navigation invalidates observations. Input delivery remains `unverified`; it is not proof of the website's resulting state. A lost result can mean input happened. Any uncertain input outcome retires access and blocks new changes in that run until reviewed; read-only diagnosis and browser closure remain available. Observation failures do not claim that input happened or block unrelated work. Commands refused before host dispatch are reported as known failures.

## Trusted host lifecycle

`hostCli.js` is built with Mira but runs as a separate host process. It needs the product database and a canonical local Docker Unix socket. The agent, dashboard and browser container receive no socket or general Docker API. The host fixes the installed immutable image and all resource settings. Its only HTTP surface is a loopback health endpoint; commands move through the private database.

The service checks the exact migration set before startup, performs startup/periodic recovery, runs at most two local sessions and drains owned sessions on SIGTERM/SIGINT. Each session independently polls its grant while idle, starting or executing. Authority queries have their own five-second ceilings; a healthy view query cannot extend a hung control query. Cancellation permanently retires the session.

Grant consumption and process reservation commit in one transaction. A crash cannot leave a consumed grant without a recoverable process record. Two global unfinished process slots include unresolved cleanup. A stable host UUID, random process UUID/name/label, immutable image and fifteen-second controller lease bind every lifecycle mutation. No private token is exposed through Chat or human APIs.

Create intent commits before Docker dispatch; the returned ID commits before startup. Settled 400/404/409 rejections are recorded. Cleanup inspects exact ownership and persists any newly discovered ID before deletion, then verifies absence before releasing capacity. Recovery can finish a known-ID deletion after a lost confirmation. Unknown creation plus a not-found name cannot prove absence and retains its slot. Recovery uses the record's original image even after updates. Expired controllers cannot renew, start, execute or confirm cleanup after replacement.

## Fixed runtime boundary

The browser worker uses the root-pinned `puppeteer-core` adapter; the shared viewer uses root-pinned `@novnc/novnc` and its type declarations. The Windows companion retains `@trycua/cua-driver` and `copyDriverRuntime.ts`; the browser no longer copies or calls that SDK. `deploy/Dockerfile` packages Chromium, Xvfb/Openbox, x11vnc and Python in the Main image. Packaged browser files explicitly remain readable by UID 1000. `browser-image.json` points its logical `mira-browser` role to the shared `dashboard` registry package and its proxy role to `mira-browser-proxy`; no separate `mira-browser` package is published. Chromium and OS packages refresh through the normal release build; there is no separate driver download or installation during deployment. Browser containers contain no host profiles or model credentials.

The fixed container runs as UID/GID 1000 with a read-only root, no host mounts or published ports, no capabilities, no-new-privileges, bounded temporary filesystems, 1536 MiB RAM, two CPUs and 256 PIDs. Broad sessions use the packaged worker directly under Docker init and the host supervisor; EOF, cancellation and durable recovery clean up its process tree. Automatic container removal and ownership-verified host cleanup remain enabled. The upstream browser no-sandbox setting is confined to this outer container boundary; do not run the worker outside it.

The private Docker connection attaches before startup and validates non-TTY framing, UTF-8, increasing request IDs and bounded JSONL. Requests are at most 64 KiB; replies at most 4 MiB. Interactive requests accept initialize, observe, tabs, navigate and act; operator-confirmed uploads use separate bounded begin/part/finish messages. Saved workers additionally accept private profile chunks before initialization; these are unavailable to model tools. The first handshake has sixty seconds for startup; subsequent calls have thirty seconds. These are operation deadlines, not session-duration limits. Invalid output, overlap, EOF or cancellation permanently retires the connection. There is no reconnect or input replay.

The origin ceiling limits observation and input, not subresource requests or page-driven navigation. External egress must be separately enforced before live websites are enabled.

## Confirmed attachment uploads

Browser uploads are private, operator-only operations for a trusted host that has already authorized exact attachment bytes. They require Control, an unused observed main-document file-input ref, and a verified filename, size and SHA-256 digest. In the unified browser, each confirmation binds the transfer to the observed page origin; a separate one-site session is unnecessary. The signed-in operator takes control in Chat, selects an existing attachment from this conversation and a freshly observed file input, then confirms its name, size and exact destination origin. View-only sessions cannot upload. The selected page and file input are rechecked after staging, including the form destination origin. Confirmation is tied to the current controller generation and observation, immutable file ID and SHA-256 digest. Admission and claim recheck ownership, conversation membership and all metadata. The model input schema still rejects uploads and never selects file paths or confirms disclosure.

The browser host alone receives the shared attachment volume with read/write access (`HOMELAB_MIRA_FILES_DIR`), with a 512 MiB memory ceiling for two bounded transfers. Chromium never mounts this store. The host reopens and verifies the selected file, copies it into contiguous 24 KiB binary chunks and sends only bounded private messages. The worker rejects gaps, duplicate offsets, invalid encoding, interleaved commands, incomplete files and digest changes before native assignment. A transfer consumes the existing 25-second operator deadline and observation lifetime; interruption permanently retires the session without replay. Database commands contain only approved metadata, never bytes, and are scrubbed on claim/completion. Files in an active conversation remain protected by the existing deletion guard.

The adapter copies and verifies at most **25 MiB total across 16 files per browser lifetime** into a private session directory in the container's existing temporary filesystem. Display filenames cannot select directories; every assignment gets its own random subdirectory, inside the existing temporary filesystem. It never mounts the product file store or returns paths. Files remain until Chromium stops so websites can read a selected file later, and session cleanup removes them. Staging consumes the observation deadline; cancellation, quota failure, invalid results and uncertain delivery retire the session without replay.

Assigning a file makes its bytes available to the approved website immediately, even before a form is submitted. An assignment result therefore reports unverified delivery; it does not claim that a website accepted a submission. The Chromium adapter revalidates the live origin and exact input node.

## Unified-browser downloads

The unified Chromium adapter keeps ordinary browser downloads disabled. A fresh operator link observation permits a fixed fetch in an isolated JavaScript world, with the current website cookies. The link must remain on the confirmed page origin; cross-origin URLs, embedded credentials and redirects are refused. Streamed and declared sizes are capped at 25 MiB before bytes reach the host. This path uses the same existing per-session byte/count limits and import verification as existing attachment imports. Model observations cannot initiate downloads or expose upload handles.

Completed downloads are limited to **25 MiB each, 100 MiB and 16 files per session**. The private worker returns a metadata header and contiguous 24 KiB chunks; the host verifies canonical encoding, exact offsets and the final digest. Models cannot invoke this protocol.

## Download to Chat

With Control access, the operator takes control, opens **Files → Choose file controls on this page**, selects a visible link and provides a display filename. The confirmation freezes that filename, website and observation. The server rechecks the signed-in human, fresh link, controller generation, grant, process and run lease at admission, claim and import. Downloads use the existing 25-second operator deadline and are never replayed after uncertainty.

The trusted host validates the bytes using the same file types, 25 MiB limit and account/global quotas as normal attachments. The user filename never selects a filesystem path. File readiness, linking to the current assistant response (maximum 100 files per run), and console completion commit atomically. Revocation, expiry, cancellation or a deleted conversation cannot publish a ready attachment. Website filenames, URLs and file bytes are absent from the command journal. The host alone can write the shared store; Chromium cannot mount it.

Chat polls the active conversation and displays the imported attachment. After control returns, `mira_browser_wait` includes current-response attachment metadata so Mira can discover and read a saved text/PDF file. Names and contents remain untrusted data; images need attachment to a subsequent message for model vision.

## Saved profiles

Mira chooses its dedicated saved profile or fresh temporary storage through `mira_browser_open`. A saved session creates or reuses the account-owned **Mira** profile for the configured network, within the existing four-profile account limit and global storage slots. Profile names, cookies, paths and credentials are not model-selectable. The profile is reserved atomically with browser admission; a failed admission cannot leave a profile or grant behind. Legacy exact-site profiles are retained without broadening them.

The dedicated profile uses the existing bounded snapshot restore/checkpoint pipeline. Chromium uses the saved profile's default context so website storage persists; temporary browsing uses a fresh context. Downloads remain denied in broad sessions, including saved ones. Saved data does not restore previous tabs. **Automations → Browser** lists saved profiles and lets the operator explicitly delete saved sign-ins; no profile selection or creation form is required to start a task.

The first reservation binds a profile to a stable browser-host UUID. Subsequent use on another host is refused. Only one unclosed grant per owner and one unfinished process per profile are admitted; cleanup uncertainty retains both reservations. Profiles are dedicated to Mira and never select the operator's existing Chrome/Edge data.

Chromium writes only to a private **64 MiB tmpfs**, enforced by the kernel with UID 1000, mode 0700 and `nosuid,nodev,noexec`. There are no persistent Docker volumes or host bind mounts. Filling browser cache or site storage reaches `ENOSPC` instead of growing server-disk usage. The existing two-process and 1.5 GiB container-memory limits also apply.

The trusted host restores a private compressed snapshot before initialization. On shutdown, input is revoked immediately and only the output side remains open for a checkpoint. The adapter closes its owned Chromium process before capturing regular profile files. The existing bounded checkpoint and unconditional container removal remain responsible for interrupted shutdown. The worker captures regular files after native cleanup, omitting runtime links. It refuses symlinks, hard links, traversal, conflicting paths, more than 5,000 entries, over 64 MiB of file contents or over 96 MiB of decompressed serialization. Private 32 KiB chunks preserve the ordinary wire limits. The host bounds checkpoint collection/persistence to 4.5 seconds and then removes the container even if saving fails. Interrupted, malformed or oversized checkpoints retain the previous saved snapshot. Browser cleanup completion does not guarantee that its latest changes could be saved.

Each private database snapshot is capped at **25 MiB of encoded payload**, with a database constraint. Profile creation reserves one of **16 unique global slots** before any browser admission, bounding live snapshot payload across all hosts to **400 MiB**. Four profiles per account still applies. Capacity is reclaimed only when an unused profile is deleted. Atomic saves serialize with controller recovery and require the exact current, unexpired process lease; removed or replaced controllers cannot overwrite later data. Snapshot contents never enter public metadata, tool results, receipts or logs.

Deleting an unused profile in Browser settings requires fresh human verification and confirmation. Once every grant and process has closed, deletion atomically clears its snapshot and releases its slot. Deleting a conversation or stopping a run does not delete its saved profile; use Delete profile explicitly.

Profiles contain sensitive site sessions and now belong to the product database's existing backup, access-control and retention boundary. The 400 MiB quota covers live snapshot payload; PostgreSQL indexes, MVCC, WAL and backups require the normal database disk monitoring and retention policy. This feature adds no separate encryption.

## Configuration and qualification

The host reads only explicitly provisioned settings:

- `HOMELAB_DASHBOARD_DATABASE_URL`: private product PostgreSQL connection.
- `HOMELAB_MIRA_BROWSER_CONFIG`: absolute path to a nonsecret JSON file containing `hostId` (stable UUID), `socketPath` (canonical local Unix socket) and `imageId` (`sha256:` configuration digest of the installed image).
- `HOMELAB_MIRA_BROWSER_HEALTH_PORT`: loopback-only health port, default 3441.

Build with `bun run build mira`; the host entry point is `bun --no-env-file apps/mira/dist/hostCli.js`. This documents the package, not authorization to activate it in production. The host uses no model login or provider credential. Deployment must give only the trusted host its required engine/database access and preserve the host UUID across upgrades.

Use the real development applications for manual browser checks. The repository has no automated test suite; inspect the affected browser operations when changing their implementation.

The release workflow builds Main once and publishes it as `dashboard`. The logical service, browser and code-runtime roles in the release manifests all point to that immutable dashboard reference. `browser-image.json` also identifies the separately published proxy. Host provisioning and updater consumption remain required before production activation.

## Human takeover and file controls

The live viewer never requests model observations while displaying frames. Passive status polling carries controller and file-control metadata without repeatedly transferring screenshots. Only the signed-in owner can view or control the session; website HTML never executes in the dashboard document.

Takeover atomically changes the controller generation under the account lock. Queued, claimed, unconsumed and not-yet-finalized model work must settle first. While the human owns the browser, model tools cannot enqueue actions or read new observations. Returning control requires an idle operator command queue. The host revokes the old input stream, confirms its process exit and invalidates old model references before dispatch. Closing the dialog leaves control with the operator.

Ordinary human interaction uses the private live stream. It is not recorded in Chat, tool receipts, audit content or a React Query mutation cache. Neither stream reconnection nor a control change replays input. Password values remain excluded from model page outlines.

File transfer retains the explicit confirmation workflow. The **Files** section obtains a fresh operator observation of file inputs and download links. Confirmed bytes, destination origin, controller generation and the live document are checked again before delivery. The old screenshot/element controls, exact-site start endpoint, native CUA browser adapters and their deadline branches have been removed; historical profile metadata remains available for deletion without broadening its scope.

### Display and observation retention

Live RFB frames travel through bounded memory buffers over the private display
socket and the authenticated WebSocket. They are neither written to files nor
added to model or product conversation history. Operator file controls retain
only the latest observation metadata for up to 60 seconds, never a PNG.

Model-requested observations remain separate. Their database result is cleared
on consumption or retirement. Existing native Codex compaction bounds visual
context and replaces old image history; the obsolete provider thread is then
deleted, with failed deletions retained for retry. Uploaded and deliberately
saved attachments keep the ordinary conversation-file lifecycle.

When qualifying or reconnecting the pinned outbound bridge, preserve each proxy
endpoint's fixed address, com.docker.network.endpoint.ifname=external and
gw_priority=1. Confirm both proxy routes with real Chromium before declaring
the network healthy; a healthy container alone does not verify external routing.

### Model control of the same window

Model observations capture the full isolated Chromium desktop with scrot directly
to memory, including tabs, menus and the address bar. Native model input uses
xdotool with fixed executables and validated argument arrays: pointer movement,
single/double/right clicks, dragging, wheel input, key combinations and literal
text at the current caret. Text goes through stdin to a short-lived clipboard owner inside the isolated desktop, never shell interpolation. Native paste supports Unicode and releases that private selection after delivery; it never reads or connects to the operator\'s PC clipboard.
These tools are Debian packages in the managed Main image.

Each native action consumes a fresh observation, checks control ownership and
the same selected document, and validates coordinates against the captured
dimensions. Website refs remain available for precise element actions. Internal
Chromium pages have no website URL or element refs, but remain visible and
operable through the native window. The model receives neither a shell nor a
CDP endpoint. Password extraction, operating human security confirmations and
unconfirmed file transfers remain outside the model tool contract.
