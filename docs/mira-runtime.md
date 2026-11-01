# Mira runtime qualification

`apps/mira` contains the isolated Codex app-server adapter and qualification CLI used
by the separate Mira executor. The product core adds authenticated dashboard APIs,
durable state, scheduling and explicit product tools; see [Mira](mira.md). Production
cutover has not occurred. The runtime's stdio connection is private, and auth and
dashboard builds remain independent. This document retains the original qualification
procedure; see the provider extension below for the current shared executor behavior.

## Synthetic subscription provider

Chat and Automations share the same server-backed model settings and UI controls.
The optional Synthetic adapter uses the documented OpenAI-compatible Chat Completions
API at `https://api.synthetic.new/openai/v1`. It does not modify the Codex runtime or
reuse ChatGPT credentials. The four supported subscription aliases are
`syn:large:text`, `syn:small:text`, `syn:large:vision` and `syn:small:vision`.
The stored and transmitted selection remains the alias. Target names, image support
and reasoning levels come from Synthetic's current public catalog; no underlying
model or capability is pinned. Unsupported saved settings fail with a visible outcome
instead of silently choosing another model or thinking level.

Provision `HOMELAB_MIRA_SYNTHETIC_OWNER` (the existing Homelab account ID) and
`HOMELAB_MIRA_SYNTHETIC_API_KEY` through the deployment's secret manager. Both are
required together, and Compose passes the credential only to the Mira service.
Other accounts cannot discover or use this subscription. The public catalog request
does not carry credentials. Subscription allowance is checked through `/v2/quotas`
before inference; an absent, invalid or exhausted allowance stops the request.
There is no fallback to paid model IDs, another account or another provider.

The inspector refreshes both catalogs independently. A provider outage removes its
currently available choices but leaves the other provider usable. Due automations
with an unavailable selection wait without advancing their occurrence. Explicit
available selections can run even while the deployment default is unavailable.
Automation preferences are copied into each conversation and queued run, including
event and Run now executions; later edits cannot change already queued work.
Existing automations retain the deployment default until edited.

Synthetic restores bounded conversation history from Homelab on every turn, including
when switching providers. This is conversation continuity, not cross-conversation
memory. Tool permissions, ownership, receipts, task steering and cancellation remain
enforced by the same server services. Streaming does not expose private reasoning.
Uncertain provider/tool outcomes are never automatically replayed. Images selected
for the turn support PNG, JPEG and WebP up to 8 MiB each, with a 24 MiB encoded turn
context limit; tool screenshots use the existing validated image boundary.

Qualification tests use an isolated database and local HTTP fixtures, never a real
provider account. Live subscription qualification is a separate deployment step.
Relevant upstream contracts: [models](https://dev.synthetic.new/docs/api/models),
[Chat Completions](https://dev.synthetic.new/docs/openai/chat-completions) and
[subscription quotas](https://dev.synthetic.new/docs/synthetic/quotas).

The [official app-server protocol](https://learn.chatgpt.com/docs/app-server) provides
authentication, streaming, thread restoration, host tools and interruption over a
private child connection. Its experimental status remains a production-readiness
gate. This pilot uses the documented native login for a personal self-hosted setup.
Evaluate [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
before broadening distribution or hosting scope. Never extract another client's
credentials or rely on undocumented endpoints.

## Run the pilot

Use Bun from `.bun-version` and `bun install --frozen-lockfile`. Mira pins the official
`@openai/codex` package, including its native platform package, in its own workspace.
Use that package's native executable directly; system wrappers may change the user
or discard `CODEX_HOME`. Scripted launchers are rejected. The protocol was qualified with Codex CLI 0.164.0;
regenerate schemas and rerun this pilot when a runtime update changes that contract.

Create an empty model workspace and a separate private Codex home outside the source
checkout. Protect the latter with owner-only permissions; on Windows use an
equivalent owner-only ACL. The pilot command does not install services or set ACLs.
Do not point it at an existing desktop or OpenClaw profile.

Example nonsecret external configuration (replace paths for the selected host):

```json
{
    "command": "/opt/homelab/node_modules/.bun/@openai+codex@0.164.0-linux-x64/node_modules/@openai/codex/vendor/x86_64-unknown-linux-musl/bin/codex",
    "codexHome": "/var/lib/homelab-mira-pilot/codex",
    "workspace": "/var/lib/homelab-mira-pilot/workspace"
}
```

Use the native executable and same explicit `CODEX_HOME` for `login --device-auth`; the owner completes
the login in their browser. Then run:

```sh
bun run mira:qualify /absolute/path/to/pilot.json
```

This makes real synthetic model calls using that login's allowance. CI never invokes
it or needs provider credentials. An optional `model` field selects an advertised
model; otherwise use the catalog default. Catalog presence alone is not entitlement.
The command succeeds only after a completed response and all lifecycle checks.
The workspace must be empty, outside a repository and without ancestor project
configuration. Validation returns canonical paths used unchanged by the child.
The dedicated home cannot contain custom configuration, instructions or skills;
Codex's own generated `.system` skills are permitted. Project document loading is
also disabled. Effective configuration, including system layers, is checked before
creating a thread: any configured MCP server fails closed, even if disabled. An
empty `mcp_servers={}` CLI override does not remove existing server entries in this
runtime version and is not used as an isolation guarantee.

## What is exercised

1. Initialize a fresh private stdio connection and inspect authentication without
   logging email, account IDs or tokens.
2. Stream a response and call a registered synthetic echo tool with validated input.
3. Stop/reap the process, reopen it and recover the random marker through stored
   conversation history.
4. Interrupt an active synthetic tool call and require an interrupted terminal event.
5. Complete another turn after interruption.

Corrected qualification on 2026-10-24 passed on Linux with Bun 1.4.4, Codex 0.164.0 and the
catalog default `gpt-6.1-sol`. No host administration, mail, publication or desktop
action was used. The pilot left its own authentication/history in its private home.
This proves the tested text/tool lifecycle, not voice entitlement or GUI control.
The initial test used a host wrapper that switched to the OpenClaw user and lost
the requested home. It is not isolation evidence. After detecting this, the pilot
was rerun with the pinned native executable and a newly approved, separate login.

## Failure behavior

The transport limits frame size, queued requests and concurrent host calls. It drains
stderr without copying provider diagnostics into reports, validates protocol
boundaries, and rejects pending calls on EOF, malformed input and timeouts. Timeouts
retire the connection; potentially started work is not automatically replayed.

One active turn is allowed per adapter. Host tools must be explicitly registered for
the restored thread, validate inputs and honor cancellation. Unknown tools, unrelated
thread/turn calls and repeated call IDs are refused. Command/file approval requests
are declined; permission requests receive no grants. Native shell, connectors,
plugins, browsing and computer features are disabled for this synthetic pilot.

The child receives a minimal OS environment and an explicit Codex home; its user-home
environment also points to that directory. Ambient API
keys and GitHub tokens are not forwarded. This environment filtering is not an OS
security sandbox: production execution still needs its planned service identity,
filesystem/network restrictions and scoped service adapters.

Tests use a synthetic child process for handshake ordering, terminal events arriving
before start acknowledgement, tool authority, concurrent turns, cancellation,
timeouts, malformed frames, disconnects and diagnostic redaction. They use no real
sessions or network calls.

## Before production integration

- The product core now persists conversations, turns, outcomes and tool receipts
  separately from provider IDs. Authenticated dashboard operations and scoped product
  tools are implemented. Retain the reconciliation rules when adding external effects;
  an uncertain receipt must not become an automatic retry.
- Enforce service-owned directories and process/resource restrictions. A configured
  executable/path is operator authority, not user chat input.
- Add runtime replacement/drain coordination and update verification to the Mira
  image. Its pinned dependency follows reviewed Homelab releases; the OpenClaw
  runtime keeps its separate native update owner.
- Qualify the Windows companion and bounded driver, including the actual desktop
  acceptance in [the delivery plan](mira.md). No desktop readiness is implied here.
- Keep voice billing separate: ChatGPT/Codex usage credits are not an API balance.
  No voice session or API payment configuration is enabled by this pilot.

## Effective runtime isolation

Initialization must return the canonical dedicated `codexHome` before account inspection. Effective configuration must retain every disabled capability, disabled web search, file-only credentials, the OpenAI provider and no custom provider definitions or MCP servers. Thread start and resume must also report `modelProvider: openai`.

The cached system skills are verified against the complete SHA-256 manifest from the pinned upstream `rust-v0.164.0` bundle. Extra, missing, altered or linked entries fail closed, regardless of the Codex marker. A Codex dependency update must update the manifest from the corresponding official source and rerun live qualification; a test checks the versions stay aligned.

The follow-up qualification passed with the stricter checks on 2026-10-24: streamed response, registered tool call, resume after process replacement, interruption and recovery using the isolated Mira login.

Effective configuration must also preserve the supported official OpenAI/ChatGPT
base URLs. Provider identity alone is insufficient: endpoint overrides, legacy
notification commands, instruction/compaction/catalog overrides, external telemetry
and alternate thread-storage paths fail initialization. The adapter force-reloads
the complete skill catalog for its empty workspace and accepts only the exact
pinned system skill paths; administrator skills and discovery errors fail closed.
The echo qualification validates its input nonce and returns a different random
receipt, proving both argument delivery and tool-output propagation.

The native executable must report the exact pinned Codex version under the scrubbed
child environment. The version probe has a time and output limit. Thread start and
resume also validate the effective canonical workspace, empty instruction sources,
untrusted approval policy and read-only sandbox without network access. The default
sleep tool is explicitly disabled with the other ambient capabilities.

Resume qualification requires the exact earlier receipt without another echo-tool
call. Recovery requires exactly `MIRA_READY`; a refusal that merely contains the
marker fails. Cancellation is rechecked after listener registration to close the
abort race. The strengthened isolated live qualification passed on 2026-10-24.

## Visual tool output

Host tools may return existing text or an explicit ordered `content` array of text
and inline PNG/JPEG images. The stable `mira_tool_call` router preserves these
items; JSON-looking text is never promoted into an image. The runtime converts
validated images to app-server `inputImage` items using data URLs only. It never
fetches a URL or reads a caller-supplied filesystem path.

Limits apply before sending: eight items, two images, two MiB total decoded image
bytes, 256 KiB total UTF-8 text, dimensions up to 8192 per side and 16,777,216
pixels per image, and three MiB for serialized content. Image-size 2.0.4 checks
format and dimensions from headers without decoding pixels. This is a metadata
and resource boundary, not a guarantee that every compressed image can decode.
Invalid output produces a fixed failure response without returning input bytes.
Cancellation is checked after the host tool completes, before images are emitted.
The pinned runtime uses explicitly enabled code mode and code-mode interruption
so its image helper can display returned images. Code-mode tool search stays off;
the model receives only the registered product tools. These settings are checked
against the effective runtime configuration before a thread can start.
Existing run ownership, tool registration and cancellation rules still apply.
An interrupted turn retires the native process and its code host. Resume the
conversation through a fresh connection, as the executor already does between
product runs; the runtime qualification exercises this same recovery path.

Run the real vision qualification separately from ordinary CI:

```sh
bun run mira:qualify-visual /absolute/path/to/pilot.json
```

It uses Mira's isolated ChatGPT login and the model catalog, so it consumes plan
usage. Two fresh six-digit PNG challenges are generated in memory. Their answers
are absent from the prompts and text tool output. The model must call the normal
tool router, display the returned data URL with the code-mode image helper, and
read each exact answer from the image. Commentary may precede the answer, but
the final line must contain the one correct six-digit code, with no conflicting
codes elsewhere. Only fixed
milestones and capability results are printed; the synthetic provider thread is
deleted afterward. CI uses synthetic transport and qualification fixtures and
never needs provider credentials or inference.

This qualifies the visual return channel only. Browser/desktop drivers, paired
hosts, session authority, takeover and live computer acceptance remain separate
requirements. No computer control, shell access, plugins or native browser tools are enabled
by this support.

Protocol reference: [Codex App Server](https://learn.chatgpt.com/docs/app-server).
The pinned Codex 0.164.0 generated `DynamicToolCallResponse` schema includes
`inputImage` with `imageUrl`; generated schema support alone is not a successful
live visual qualification.

## Packaged executor qualification

Mira's image includes both `codex` and its sibling `codex-code-mode-host` from
the same pinned native package. Code mode is required for the registered product
tools. A successful sign-in, model catalog or text response does not prove that
those tools work. The credential-free artifact smoke test executes both binaries;
the container-image workflow runs it before publication.

To qualify the actual service, use a Linux Docker host as UID 1000 with local
`postgres:18` and the exact Mira image built from the current checkout:

```sh
bun run mira:qualify-container homelab-release/mira:tested /absolute/dedicated-mira-codex-home
# Optionally select an explicitly available model for this synthetic qualification:
bun run mira:qualify-container homelab-release/mira:tested /absolute/dedicated-mira-codex-home gpt-6-luna
```

This is an operator-invoked live test that consumes ChatGPT plan usage, not an
ordinary CI check. Use only Mira's separately approved profile, with other users of
that profile stopped. Never use an OpenClaw or desktop login directory. The test
mounts that profile read/write so the native runtime owns refresh and history; it
does not read or print credentials. Its optional model choice affects only the
synthetic configuration and never changes production preferences or silently falls
back to another model.

The harness resolves both local images to immutable IDs without pulling. It starts
an isolated Docker network, a dedicated PostgreSQL database with persistent test
storage, and the real executor entry point with the production resource/security
restrictions. Only the synthetic database has a loopback host port. No integration
tokens or production database are supplied. The fixture sends text, PDF and PNG
attachments through the durable queue and requires a successful `mira_tasks_list`
receipt. It then stops and removes the executor, queues a continuation while no
executor exists, and verifies a new worker resumes the same provider thread with
the earlier marker. Finally it requires recorded provider-history deletion and a
clean zero-exit service shutdown before removing its fixtures.

On failure or interruption, shutdown is attempted and synthetic fixtures are
retained. The printed directory contains `retained.json` with exact resource IDs
and whether shutdown was confirmed. Inspect those resources only. Before deleting
them, cancel any active synthetic run, delete its conversation through the product
conversation service, and run the original executor against the retained synthetic
database until all `provider_thread` references are cleared. The profile itself is
never removed. A failed assertion is not a successful qualification, and retained
history must not be hidden by dropping its database.

On 2026-10-28 the actual hardened image passed this live service qualification
with the separately approved Mira profile and the advertised `gpt-6-luna` model:
text/PDF/image input, recorded product tool, queued-while-stopped continuation,
same provider thread under a new worker, provider-history deletion and graceful
shutdown. The credential-free smoke also rejected an image missing the code-mode
host. This does not qualify production cutover or Windows computer control.
