# Mira server browser

Chat now declares browser wait, observation, navigation and input tools. The separate trusted browser host consumes their durable commands and owns Docker cleanup. Chat includes human origin/mode selection and a direct stop control using the shared responsive components.

**Deployment is not activated.** Offline sessions use `NetworkDisabled` and `NetworkMode: none`. Explicitly configured public sessions use one isolated Docker slot and its verified Squid/nft proxy, as documented in `deploy/README.md`. Real Chromium, synthetic public DNS/HTTP/TLS and direct/private destination refusal are qualified; live host provisioning and updater activation remain deployment gates. A website origin grant is not a network firewall.

## Human authority

- The independent `computer:browser` switch defaults off. A freshly verified signed-in operator grants exact canonical HTTP(S) origins, an initial URL and view/control mode for an owned running manual job. Models cannot create, broaden, renew or approve grants.
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

Bun 1.4.4 and the unmodified `@trycua/cua-driver` 0.37.0 are pinned. `deploy/browser/Dockerfile` packages Chromium, Xvfb/Openbox and only the locked native SDK closure beside the bundled fixed worker. It contains no host profiles, model credentials, test sites or repository source.

The fixed container runs as UID/GID 1000 with a read-only root, no host mounts or published ports, no capabilities, no-new-privileges, bounded temporary filesystems, 1536 MiB RAM, two CPUs and 256 PIDs. Docker init, automatic removal and `/usr/bin/timeout --signal=KILL 305s` bound descendants independently of native cleanup. The upstream browser no-sandbox setting is confined to this outer container boundary; do not run the worker outside it.

The private Docker connection attaches before startup and validates non-TTY framing, UTF-8, increasing request IDs and bounded JSONL. Requests are at most 64 KiB; replies at most 4 MiB. Only initialize, observe, navigate and act are accepted. The first handshake has sixty seconds for sequential native startup; subsequent calls have thirty seconds, with ten-second native operation limits. Invalid output, overlap, EOF or cancellation permanently retires the connection. There is no reconnect or input replay.

The origin ceiling limits observation and input, not subresource requests or page-driven navigation. External egress must be separately enforced before live websites are enabled. Persistent profiles, downloads/uploads and additional tabs remain separate deployment work.

## Configuration and qualification

The host reads only explicitly provisioned settings:

- `HOMELAB_DASHBOARD_DATABASE_URL`: private product PostgreSQL connection.
- `HOMELAB_MIRA_BROWSER_CONFIG`: absolute path to a nonsecret JSON file containing `hostId` (stable UUID), `socketPath` (canonical local Unix socket) and `imageId` (`sha256:` configuration digest of the installed image).
- `HOMELAB_MIRA_BROWSER_HEALTH_PORT`: loopback-only health port, default 3441.

Build with `bun run build:mira`; the host entry point is `bun --no-env-file apps/mira/dist/hostCli.js`. This documents the package, not authorization to activate it in production. The host uses no model login or provider credential. Deployment must give only the trusted host its required engine/database access and preserve the host UUID across upgrades.

`bun run test:browser` qualifies native capture, literal trusted typing/clicking, one-use refs, origin refusal, frozen-driver cleanup and the private worker protocol in offline containers. `bun run test:browser:image <local-image>` verifies the unchanged release image and real worker behavior; a qualification-only Docker exec supplies its synthetic loopback site without changing image layers.

`bun run test:browser:service` requires the fixture image built by `test:browser`. It builds and starts the actual host CLI against a disposable PostgreSQL allocation, invokes the real Chat tools, verifies native PNG delivery and independent trusted DOM events, then sends SIGTERM and proves container removal, closed grants and erased transient results. The required Isolated browser CI job runs these qualifications plus the public-egress qualification before release images can be published. PRs never publish images.

Real-database integration tests additionally cover competing hosts, stale controller/run identities, one-time result consumption, view-only scope, human stop, uncertain input, atomic startup rollback and cleanup failures. Shared-component tests and the disposable Chat preview cover explicit origin submission, stale/paused/text-only refusal, direct stop and viewport-bounded responsive dialogs.

The release workflow transfers and publishes the exact tested browser image without rebuilding and attaches `browser-image.json` with its immutable reference. Host provisioning, egress qualification and updater consumption remain required before production activation.

## Preview and human takeover

Open browser in Chat displays the latest completed observation without asking Chromium for another snapshot. Passive dashboard polling therefore cannot invalidate the model's one-use refs. Only the signed-in owner can read the bounded PNG, title and URL; the page is never embedded as active HTML. Images expire after sixty seconds, are hidden on stale/error status and are erased on revocation, conversation deletion and host cleanup. The dialog removes its image query cache on closing.

Take control atomically changes the controller generation while holding the same account lock as model-command admission. Queued, claimed, unconsumed and not-yet-finalized model work must settle first. While the human owns the browser, model tools cannot enqueue actions or read new observations. The wait tool reports the human controller and can wait for an explicit return. Closing the dialog does not return control; the original grant, job budget, pause controls and five-minute process limit still apply.

Human Refresh view, approved navigation and observed-element click/type use the same serialized host port. There is one operator command per grant, 128 unique attempts per session and a twenty-five-second command ceiling. Epoch checks exclude stale tabs; retained request IDs prevent replay. Returning to Mira requires an idle command queue and erases the operator observation; Mira must observe again before input. Single-use refs remain mandatory. Mira retains a ten-second observation limit; only the host-verified operator queue can request a sixty-second observation for manual entry. This flag is absent from the model and human API command schemas and cannot extend the grant or native idle/lifetime limits. A typing draft survives refresh so the operator can prepare text before choosing a fresh element.

Operator text is sent directly to the private command queue, not Chat, tool receipts, audit content or the browser's React Query mutation cache. It is masked in the entry field and cleared on submission. Queue payloads are erased on claim; input never produces a stored response. Errors and unknown delivery are not automatically retried. Actual Chromium qualification covers operator screenshots, trusted typing/clicking, returning to Mira and complete shutdown cleanup. The console uses observed page elements rather than a remote desktop stream; it does not add arbitrary JavaScript, coordinates, browser chrome controls or new origin permissions.
