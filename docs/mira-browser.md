# Mira server browser

Chat now declares browser wait, observation, navigation and input tools. The separate trusted browser host consumes their durable commands and owns Docker cleanup. Chat includes human origin/mode selection and a direct stop control using the shared responsive components.

**Deployment is explicit and independent of the account switch.** Offline sessions use `NetworkDisabled` and `NetworkMode: none`. Explicitly configured public sessions use one isolated Docker slot and its verified Squid/nft proxy, as documented in `deploy/README.md`. Real Chromium, synthetic public DNS/HTTP/TLS and direct/private destination refusal are qualified. Provision and qualify the live host before enabling the account switch. A website origin grant is not a network firewall.

## Human authority

- The independent `computer:browser` switch defaults off. Manage it in **Automations → Browser**, with the same reason and optional resume time as other controls. Enabling the switch does not grant a website or start a session. Pausing it invalidates current browser access; resuming requires a fresh grant in Chat. A freshly verified signed-in operator grants exact canonical HTTP(S) origins, an initial URL and view/control mode for an owned running manual job. Models cannot create, broaden, renew or approve grants.
- Grants expire within five minutes and the run budget. One unclosed grant per account and twenty requests per hour bound admission. Control-generation changes, cancellation, expired worker leases and deleted conversations permanently invalidate existing authority.
- Chat defaults to View only. Image-capable models get the four browser tools; text-only and automatic runs cannot use them. `mira_browser_wait` holds a manual run for up to sixty seconds while the operator decides; it does not request access.
- Stopping pending access closes it immediately. Stopping claimed access revokes authority and erases transient command content, but retains its capacity until the trusted host confirms container absence. Stale UI status cannot authorize execution and does not hide the stop control.
- Browser content, labels and pixels are untrusted data. Input requires an observed ref and a fresh, ten-second, single-use observation ID. There is no arbitrary JavaScript, CDP, shell, existing-profile selection or operator-PC access.

## Durable command delivery

`mira_browser_commands` binds each command to a server-reserved tool receipt, owner, run lease and human grant. The host claims it once for the exact durable process/controller generation. A claimed command is never reclaimed or replayed. Browser startup can consume up to sixty seconds; queued commands expire within one hundred seconds and claimed commands within twenty-five seconds. At most one outstanding command per grant, sixty-four commands per grant and thirty-two outstanding globally bound content and work.

Each stage checks the live run, tool receipt, grant scope, process generation and deadlines. Result completion, one-time consumption and final model disclosure remain separately fenced. Images, dimensions, URL origins and element references are validated before delivery. Result content is erased on consumption, cancellation, expiry and conversation deletion; content-free tombstones prevent replay. Provider-independent cleanup also runs in the ordinary Mira executor if the browser host is unavailable.

Navigation invalidates observations. Input delivery remains `unverified`; it is not proof of the website's resulting state. A lost result can mean input happened. Any uncertain outcome retires access and blocks further tool actions in that run until reviewed.

## Trusted host lifecycle

`hostCli.js` is built with Mira but runs as a separate host process. It needs the product database and a canonical local Docker Unix socket. The agent, dashboard and browser container receive no socket or general Docker API. The host fixes the installed immutable image and all resource settings. Its only HTTP surface is a loopback health endpoint; commands move through the private database.

The service checks the exact migration set before startup, performs startup/periodic recovery, runs at most two local sessions and drains owned sessions on SIGTERM/SIGINT. Each session independently polls its grant while idle, starting or executing. Authority queries have their own five-second ceilings; a healthy view query cannot extend a hung control query. Cancellation permanently retires the session.

Grant consumption and process reservation commit in one transaction. A crash cannot leave a consumed grant without a recoverable process record. Two global unfinished process slots include unresolved cleanup. A stable host UUID, random process UUID/name/label, immutable image and fifteen-second controller lease bind every lifecycle mutation. No private token is exposed through Chat or human APIs.

Create intent commits before Docker dispatch; the returned ID commits before startup. Settled 400/404/409 rejections are recorded. Cleanup inspects exact ownership and persists any newly discovered ID before deletion, then verifies absence before releasing capacity. Recovery can finish a known-ID deletion after a lost confirmation. Unknown creation plus a not-found name cannot prove absence and retains its slot. Recovery uses the record's original image even after updates. Expired controllers cannot renew, start, execute or confirm cleanup after replacement.

## Fixed runtime boundary

Bun 1.4.4 and the unmodified official CUA CLI 0.38.0 are pinned. `driverRelease.json` records the upstream release URL, exact archive size and SHA-256; image builds verify these before extracting the executable. `deploy/browser/Dockerfile` packages Chromium, Xvfb/Openbox and the CLI beside the bundled fixed worker. The Windows SDK remains independently pinned to 0.37.0. It contains no host profiles, model credentials, test sites or repository source.

The fixed container runs as UID/GID 1000 with a read-only root, no host mounts or published ports, no capabilities, no-new-privileges, bounded temporary filesystems, 1536 MiB RAM, two CPUs and 256 PIDs. Docker init, automatic removal and `/usr/bin/timeout --signal=KILL 305s` bound descendants independently of native cleanup. The upstream browser no-sandbox setting is confined to this outer container boundary; do not run the worker outside it.

The private Docker connection attaches before startup and validates non-TTY framing, UTF-8, increasing request IDs and bounded JSONL. Requests are at most 64 KiB; replies at most 4 MiB. Interactive requests accept initialize, observe, navigate and act; operator-confirmed uploads use separate bounded begin/part/finish messages. Saved workers additionally accept private profile chunks before initialization; these are unavailable to model tools. The first handshake has sixty seconds for sequential native startup; subsequent calls have thirty seconds, with ten-second native operation limits. Invalid output, overlap, EOF or cancellation permanently retires the connection. There is no reconnect or input replay.

The origin ceiling limits observation and input, not subresource requests or page-driven navigation. External egress must be separately enforced before live websites are enabled. Download delivery to Chat and additional tabs remain separate work.

## Confirmed attachment uploads

The native adapter now has a private, opt-in upload operation for a trusted host that has already authorized exact attachment bytes. It requires Control with **one exact origin**, an unused observed main-document file-input ref, and a verified filename, size and SHA-256 digest. The signed-in operator takes control in Chat, selects an existing attachment from this conversation and a freshly observed file input, then confirms its name, size and exact destination origin. View-only or multi-origin sessions cannot upload. Confirmation is tied to the current controller generation and observation, immutable file ID and SHA-256 digest. Admission and claim recheck ownership, conversation membership and all metadata. The model input schema still rejects uploads and never selects file paths or confirms disclosure.

The browser host alone receives the shared attachment volume with read/write access (`HOMELAB_MIRA_FILES_DIR`), with a 512 MiB memory ceiling for two bounded transfers. Chromium never mounts this store. The host reopens and verifies the selected file, copies it into contiguous 24 KiB binary chunks and sends only bounded private messages. The worker rejects gaps, duplicate offsets, invalid encoding, interleaved commands, incomplete files and digest changes before native assignment. A transfer consumes the existing 25-second operator deadline and observation lifetime; interruption permanently retires the session without replay. Database commands contain only approved metadata, never bytes, and are scrubbed on claim/completion. Files in an active conversation remain protected by the existing deletion guard.

The adapter copies and verifies at most **25 MiB total across 16 files per browser lifetime** into a private session directory in the container's existing temporary filesystem. Display filenames cannot select directories; every assignment gets its own random subdirectory, and the native manifest permits reading only that staging root. It never mounts the product file store or returns paths. Files remain until Chromium stops so websites can read a selected file later, and session cleanup removes them. Staging consumes the observation deadline; cancellation, quota failure, invalid results and uncertain delivery retire the session without replay.

Assigning a file makes its bytes available to the approved website immediately, even before a form is submitted. An assignment result therefore reports unverified delivery; it does not claim that a website accepted a submission. The unchanged CUA driver revalidates the live origin and exact input node. Actual offline Chromium qualification verifies the submitted bytes and filename, delayed reading, refusal after page-driven navigation outside the approved origin, and staging removal. Unit tests cover byte/count limits, tampering, cancellation and single-use refs. Download delivery to Chat remains separate work.

## Native download qualification

The browser now uses the official bounded `serve` daemon and its persistent `mcp --socket` connection. The host approves the immutable manifest at launch; there is no standalone/unrestricted fallback, private approval-argument injection or SDK patch. MCP uses JSON-RPC 2.0, validates the exact CLI version, and ends the private session before reaping both children. Runtime downloads of executables are not allowed.

Native downloads are opt-in, Control-only and restricted to one exact origin. Only a fresh operator observation of a visible link can select a download; model observations cannot. Every observation is consumed once. The driver re-attests the origin and link, writes into its private session destination, and returns only an opaque artifact ID and completed byte count. Collection accepts one regular, single-link artifact, refuses symlinks, partials, ambiguous extra files and changed sizes, computes SHA-256 and deletes the staging file after reading.

Completed files are limited to **25 MiB each, 100 MiB and 16 files per session**. The native operation has a ten-second deadline. The container's existing **256 MiB temporary filesystem** bounds bytes while Chromium is downloading; the 25 MiB acceptance check occurs after completion, not during network transfer. Oversized or uncertain downloads retire the session. No filename, URL or model argument selects a destination path. These bytes are not executed.

The offline Chromium test downloads and compares 100,003 bytes, verifies the digest, and proves that model observations and replay cannot dispatch a download. The private worker returns a bounded metadata header and contiguous 24 KiB chunks, checked for canonical encoding, exact offsets and final digest by the trusted host. Models cannot invoke this protocol.

## Download to Chat

With single-website Control access, the operator takes control, refreshes the view, selects a visible link and provides a display filename. The confirmation freezes that filename, website and observation. The server rechecks the signed-in human, fresh link, controller generation, grant, process and run lease at admission, claim and import. Downloads use the existing 25-second operator deadline and are never replayed after uncertainty.

The trusted host validates the bytes using the same file types, 25 MiB limit and account/global quotas as normal attachments. The user filename never selects a filesystem path. File readiness, linking to the current assistant response (maximum eight files), and console completion commit atomically. Revocation, expiry, cancellation or a deleted conversation cannot publish a ready attachment. Website filenames, URLs and file bytes are absent from the command journal. The host alone can write the shared store; Chromium cannot mount it.

Chat polls the active conversation and displays the imported attachment. After control returns, `mira_browser_wait` includes current-response attachment metadata so Mira can discover and read a saved text/PDF file. Names and contents remain untrusted data; images need attachment to a subsequent message for model vision. The native service qualification compares 100,003 bytes through real Chromium, the private worker, database import and conversation linking, including a misleading website filename that is ignored.

## Saved profiles

Temporary browsing remains the default. A freshly verified human can create up to four account-owned profiles in Chat's browser dialog, each with a name and an immutable list of approved origins. Selecting a profile never grants access by itself: the human still approves a running manual job, exact origins, initial URL and view/control mode. The grant's origins must be a subset of the profile's origins. Models and automation tokens cannot create, select, delete or broaden profiles. The public API returns metadata only, never cookies or storage paths.

The first reservation binds a profile to a stable browser-host UUID. Subsequent use on another host is refused. Only one unclosed grant per owner and one unfinished process per profile are admitted; cleanup uncertainty retains both reservations. Profiles are dedicated to Mira and never select the operator's existing Chrome/Edge data.

Chromium writes only to a private **64 MiB tmpfs**, enforced by the kernel with UID 1000, mode 0700 and `nosuid,nodev,noexec`. There are no persistent Docker volumes or host bind mounts. Filling browser cache or site storage reaches `ENOSPC` instead of growing server-disk usage. The existing two-process and 1.5 GiB container-memory limits also apply.

The trusted host restores a private compressed snapshot before initialization. On shutdown, input is revoked immediately and only the output side remains open for a checkpoint. The adapter sends only Chromium's fixed, parameterless [`Browser.close`](https://chromedevtools.github.io/devtools-protocol/tot/Browser/#method-close) lifecycle command to its attested local browser, waits up to 1.2 seconds, then always shuts down the unchanged native daemon. The worker captures regular files after native cleanup, omitting runtime links. It refuses symlinks, hard links, traversal, conflicting paths, more than 5,000 entries, over 64 MiB of file contents or over 96 MiB of decompressed serialization. Private 32 KiB chunks preserve the ordinary wire limits. The host bounds checkpoint collection/persistence to 4.5 seconds and then removes the container even if saving fails. Interrupted, malformed or oversized checkpoints retain the previous saved snapshot. Browser cleanup completion does not guarantee that its latest changes could be saved.

Each private database snapshot is capped at **25 MiB of encoded payload**, with a database constraint. Profile creation reserves one of **16 unique global slots** before any browser admission, bounding live snapshot payload across all hosts to **400 MiB**. Four profiles per account still applies. Capacity is reclaimed only when an unused profile is deleted. Atomic saves serialize with controller recovery and require the exact current, unexpired process lease; removed or replaced controllers cannot overwrite later data. Snapshot contents never enter public metadata, tool results, receipts or logs.

Deleting an unused profile requires fresh human verification and confirmation. Once every grant and process has closed, deletion atomically clears its snapshot and releases its slot. Deleting a conversation or stopping a run does not delete its saved profile; use Delete profile explicitly.

Profiles contain sensitive site sessions and now belong to the product database's existing backup, access-control and retention boundary. The 400 MiB quota covers live snapshot payload; PostgreSQL indexes, MVCC, WAL and backups require the normal database disk monitoring and retention policy. This feature adds no separate encryption. The native qualification fills the real tmpfs until `ENOSPC`, saves a synthetic persistent HttpOnly cookie, replaces the entire container, restores the cookie through private chunks and proves temporary browsing stays isolated.

## Configuration and qualification

The host reads only explicitly provisioned settings:

- `HOMELAB_DASHBOARD_DATABASE_URL`: private product PostgreSQL connection.
- `HOMELAB_MIRA_BROWSER_CONFIG`: absolute path to a nonsecret JSON file containing `hostId` (stable UUID), `socketPath` (canonical local Unix socket) and `imageId` (`sha256:` configuration digest of the installed image).
- `HOMELAB_MIRA_BROWSER_HEALTH_PORT`: loopback-only health port, default 3441.

Build with `bun run build mira`; the host entry point is `bun --no-env-file apps/mira/dist/hostCli.js`. This documents the package, not authorization to activate it in production. The host uses no model login or provider credential. Deployment must give only the trusted host its required engine/database access and preserve the host UUID across upgrades.

`bash scripts/testBrowser.sh` qualifies native capture, literal trusted typing/clicking, one-use refs, origin refusal, frozen-driver cleanup and the private worker protocol in offline containers. `bun --no-env-file apps/mira/src/server/testing/browserImageSmoke.ts <local-image>` verifies the unchanged release image and real worker behavior; a qualification-only Docker exec supplies its synthetic loopback site without changing image layers.

`bash scripts/testBrowserService.sh` requires the fixture image built by `bash scripts/testBrowser.sh`. It builds and starts the actual host CLI against a disposable PostgreSQL allocation, invokes the real Chat tools, verifies native PNG delivery and independent trusted DOM events, then sends SIGTERM and proves container removal, closed grants and erased transient results. The Isolated browser CI job runs these qualifications plus the public-egress qualification before release images can be published. PRs never publish images.

Real-database integration tests additionally cover competing hosts, stale controller/run identities, one-time result consumption, view-only scope, human stop, uncertain input, atomic startup rollback and cleanup failures. Shared-component tests and the disposable Chat preview cover explicit origin submission, stale/paused/text-only refusal, direct stop and viewport-bounded responsive dialogs.

The release workflow transfers and publishes the exact tested browser image without rebuilding and attaches `browser-image.json` with its immutable reference. Host provisioning, egress qualification and updater consumption remain required before production activation.

## Preview and human takeover

Open browser in Chat displays the latest completed observation without asking Chromium for another snapshot. Passive dashboard polling therefore cannot invalidate the model's one-use refs. Only the signed-in owner can read the bounded PNG, title and URL; the page is never embedded as active HTML. Images expire after sixty seconds, are hidden on stale/error status and are erased on revocation, conversation deletion and host cleanup. The dialog removes its image query cache on closing.

Take control atomically changes the controller generation while holding the same account lock as model-command admission. Queued, claimed, unconsumed and not-yet-finalized model work must settle first. While the human owns the browser, model tools cannot enqueue actions or read new observations. The wait tool reports the human controller and can wait for an explicit return. Closing the dialog does not return control; the original grant, job budget, pause controls and five-minute process limit still apply.

Human Refresh view, approved navigation and observed-element click/type use the same serialized host port. There is one operator command per grant, 128 unique attempts per session and a twenty-five-second command ceiling. Epoch checks exclude stale tabs; retained request IDs prevent replay. Returning to Mira requires an idle command queue and erases the operator observation; Mira must observe again before input. Single-use refs remain mandatory. Mira retains a ten-second observation limit; only the host-verified operator queue can request a sixty-second observation for manual entry. This flag is absent from the model and human API command schemas and cannot extend the grant or native idle/lifetime limits. A typing draft survives refresh so the operator can prepare text before choosing a fresh element.

Operator text is sent directly to the private command queue, not Chat, tool receipts, audit content or the browser's React Query mutation cache. It is masked in the entry field and cleared on submission. Queue payloads are erased on claim; input never produces a stored response. Errors and unknown delivery are not automatically retried. Actual Chromium qualification covers operator screenshots, trusted typing/clicking, returning to Mira and complete shutdown cleanup. The console uses observed page elements rather than a remote desktop stream; it does not add arbitrary JavaScript, coordinates, browser chrome controls or new origin permissions.
