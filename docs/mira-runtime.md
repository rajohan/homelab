# Mira runtime qualification

`apps/mira` contains the isolated Codex app-server adapter and qualification CLI used
by the separate Mira executor. The product core adds authenticated dashboard APIs,
durable state, scheduling and explicit product tools; see [Mira](mira.md). The runtime's stdio connection is private, and auth and dashboard builds remain
independent. This document describes the runtime and its qualification procedure.

## ChatGPT model selection

Chat and Automations share the native Codex model catalog and capability controls.
Settings stay editable during work; model, thinking and code target
changes apply to the next run while existing runs keep their frozen settings.
Display preferences apply immediately. Permission changes revoke delegated approvals
and apply to new actions in the current run. Recall restrictions prevent further
retrieval but cannot withdraw context already sent to the model.

Mira uses ChatGPT/Codex exclusively. The executor refreshes its native model catalog
and reported quota. An unavailable selection waits without advancing an automation's
occurrence; an explicitly available model can still run when the deployment default
is unavailable. Automation preferences are copied into conversations and queued runs.
There is no alternate provider or subscription credential in the executor.

The removal migration resets retired provider model/effort/speed preferences to the
ChatGPT default in conversations, automation definitions and queued runs, preserving
all other settings, pauses, messages and historical outcomes. Cached catalogs and
quotas are cleared until the executor reports fresh values. Remove retired provider
secrets from deployment configuration; they are no longer read or passed by Compose.

The [official app-server protocol](https://learn.chatgpt.com/docs/app-server) provides
authentication, streaming, thread restoration, host tools and interruption over a
private child connection. Its experimental status remains a production-readiness
gate. This pilot uses the documented native login for a personal self-hosted setup.
Evaluate [Sign in with ChatGPT](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
before broadening distribution or hosting scope. Never extract another client's
credentials or rely on undocumented endpoints.

## Run the pilot

Use Bun from `.bun-version` and `bun install --frozen-lockfile`. Mira pins the official
`@openai/codex` package, including its native platform package, in the root manifest.
Run `bun run build mira` and use `apps/mira/dist/runtime/codex` directly; the build
extracts system-skill fingerprints and installs the complete release-owned upstream
skill trees beside the executable. Work runs register only enabled packages with
native Codex discovery; see [Mira skills](mira-skills.md). System wrappers may change the user
or discard `CODEX_HOME`. Scripted launchers are rejected. The protocol was qualified with Codex CLI 0.164.0;
regenerate schemas and rerun this pilot when a runtime update changes that contract.

Create an empty model workspace and a separate private Codex home outside the source
checkout. Protect the latter with owner-only permissions; on Windows use an
equivalent owner-only ACL. The pilot command does not install services or set ACLs.
Do not point it at an existing desktop or OpenClaw profile.

Example nonsecret external configuration (replace paths for the selected host):

```json
{
    "command": "/opt/homelab/apps/mira/dist/runtime/codex",
    "codexHome": "/var/lib/homelab-mira-pilot/codex",
    "workspace": "/var/lib/homelab-mira-pilot/workspace"
}
```

The dashboard's Chat connection status verifies the stored ChatGPT login with an
managed-authentication refresh during periodic inspection and after login. Expired or
revoked credentials are shown separately from connection failures. Quota telemetry is
optional: a quota-service error alone does not block model discovery or inference.
Turn preparation reuses the periodic authentication check and refreshes again only
if the provider rejects authorization.

An operator with Run jobs and Worker control permission can select **Sign in again**.
The existing native device-code flow supplies an OpenAI link and one-time code directly
in Chat. Only the initiating operator sees that code. Complete the login on OpenAI's
page; the dashboard confirms verified success and refreshes the model catalog.
The code is cleared after completion, cancellation, expiry or executor restart.
Provider credentials stay in the existing private Codex home.

Messages waiting for authentication display the reason and retain their existing
queue identity. The normal Stop control cancels them. Reconnecting resumes unstarted
messages automatically; failed or uncertain turns that already reached the provider
are not replayed. Connection failures retry automatically without requiring a new login.

For initial host setup, the native executable with the same explicit `CODEX_HOME`
also supports `login --device-auth`. For the optional runtime qualification, run:

```sh
bun --no-env-file apps/mira/src/server/cli/qualify.ts /absolute/path/to/pilot.json
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

## Streamed replies

Message deltas are provisional. Each completed provider message replaces that item's
provisional text, including missing final chunks and corrections. Reply IDs and Unicode
code-point offsets remain stable as earlier parts change; duplicate completion events
and late deltas do not duplicate text. A part without confirmed completion is marked
as interrupted once later replies or run completion close it. It is not promoted to
successful recall merely because the overall run completes. Existing legacy history
keeps its previous interpretation.

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

Initialization must return the canonical dedicated `codexHome` before account inspection. Effective configuration must retain every disabled capability, web search disabled by default, file-only credentials, the OpenAI provider and no custom provider definitions or MCP servers. Direct manual Chat enables live provider web search at thread start and resume. Tasks and automations keep their existing tool sets. Thread start and resume must also report `modelProvider: openai`.

The root `package.json` and `bun.lock` select the Codex version. The Mira build starts that exact native executable in a temporary unauthenticated profile, extracts its bundled system skills and writes their SHA-256 fingerprints beside the packaged executable. No second version or hand-maintained hash list is committed. The native runtime refreshes its own generated cache during initialization; Mira checks its contents and effective catalog before creating a thread. Extra, missing, altered or linked entries still fail closed. Dependency PRs update the package and lockfile; the build regenerates the skill metadata automatically.

The follow-up qualification passed with the stricter checks on 2026-10-24: streamed response, registered tool call, resume after process replacement, interruption and recovery using the isolated Mira login.

The 0.166.0 dependency qualification on 2026-11-02 also passed against the actual native binary in a new unauthenticated home: exact version, initialization, effective configuration, system-skill integrity, account protocol, model catalog and isolated thread creation. Its 69 system-skill entries match the official `rust-v0.166.0` source and have no content changes from 0.164.0. This offline check uses no provider credentials or inference.

The authenticated 0.166.0 lifecycle qualification subsequently passed on 2026-11-02 with the existing isolated Mira profile and `gpt-6.1-sol`: streaming, validated echo-tool input and output, retained context after process replacement, interruption and recovery. It used a new empty workspace and synthetic tools only; production and desktop access were not involved.

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
pixels per image, and three MiB for serialized content. Image-size 2.1.0 checks
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
bun --no-env-file apps/mira/src/server/cli/qualifyVisual.ts /absolute/path/to/pilot.json
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

## Packaged executor verification

Main bundles `codex` and its sibling `codex-code-mode-host` from the same root-pinned
native package. Build it with:

```sh
docker build -f deploy/Dockerfile --build-arg APP=homelab -t homelab-main:local .
```

The former packaged-executor test harness has been removed. A successful build
alone does not establish provider login or tool readiness. After an authorized
release deployment, use the normal Chat interface to complete a response with a
read-only product tool, continue the same conversation, and confirm the recorded
outcome and service readiness. Use the established deployment procedure for
backup, migration and recovery; do not mount a live profile into a second executor.

For a separately authorized protocol check with a dedicated profile, the supported
manual commands remain `apps/mira/src/server/cli/qualify.ts` and `qualifyVisual.ts`,
described above. They consume provider allowance and are never run by CI. They
check the adapter protocol, not the full packaged service or Windows access.

### Chat run duration

Ordinary direct Chat has no elapsed-time deadline: it runs until provider completion,
operator Stop, or an actual execution/connection failure. A zero `mira_runs.budget_seconds`
records this policy; the executor and browser/computer authority checks share it.
Codex receives `timeoutMs: null` for these runs. Transport requests,
individual commands, leases and local access grants retain their own deadlines.
Explicit automation/task budgets and timed live-assistance choices still apply.

### Long conversations and screenshot expiry

Visual history has a separate transport budget from the model's token window.
After twelve image results or eight MiB of encoded images, the Codex adapter asks
for a completed model turn before accepting another tool action. The executor
continues the same product run after context maintenance; no existing action is
replayed. Maintenance never starts while a tool or provider turn is active.

Codex owns summarization through `thread/compact/start`. Mira copies the latest
native checkpoint and subsequent text into an independent provider thread using
`thread/inject_items`, removes expired image copies, and verifies native compaction
before switching the owned conversation reference under its existing run lease.
Opaque compaction items remain unchanged during transfer. The pinned runtime's
read-only rollout format is validated; unsupported, changed or incomplete history
fails without replacing the original. Already oversized legacy history preserves
its existing checkpoint and later text without resending the rejected image body.
Facts visible only in an old, unrecorded screenshot cannot be recovered after expiry.

Before the next run starts its first model turn, remaining image copies from the
previous reply are retired. A completed reply is recorded immediately instead of
waiting for another provider compaction under a misleading working status. The
predecessor is permanently deleted through the native API after the replacement is committed.
Failed replacements and unacknowledged deletions remain in the durable retirement
queue; cleanup retries only while that conversation is idle. Failed or interrupted
runs preserve the source for the next safe maintenance attempt. User-uploaded files,
product messages, memories and tool receipts are not deleted by this mechanism.
Backups retain their existing retention policy; this does not rewrite old backups.

Regression coverage includes native compaction lifecycle/cancellation, complete
call/output boundaries, image withdrawal, database lease loss, failed compaction,
and deferred deletion. A live qualification
with the pinned Codex runtime on 2026-11-11 preserved a visually read random value,
the original task reference and completed-action context after image-free transfer;
both generated test threads were deleted afterward. Production activation uses the
normal reviewed release and additive `provider_retired_threads` migration.

## Voice

Set `HOMELAB_MIRA_OPENAI_API_KEY` in the existing scoped Doppler dashboard configuration.
The dashboard exchanges WebRTC offers with OpenAI; the API key never reaches the browser.
No additional browser package, runtime service or production image is needed.

Microphone capture, microphone pause and spoken replies are independent. Turning the
microphone off releases its tracks; pausing removes its track from the sender while replies
can still play. With both directions off, the audio connection closes. A message's speaker
button reads that earlier reply without enabling automatic spoken replies. Stop reading
only stops audio; the ordinary Stop action still stops Mira's task.

The voice model selector uses the account's current Realtime catalog (initially
`gpt-realtime-2.1-mini`). Built-in speaking voices are selected separately and can be previewed.
These preferences belong to the selected conversation in this browser. The selected ChatGPT
conversation model, credentials, permissions and billing still handle all
reasoning, tools and tasks. OpenAI API usage pays only for voice and transcription; campaign
credit balance is deliberately not displayed.

Final speech transcripts enter the same durable, idempotent message route as typed text,
including guidance while Mira works. Replies remain visible as text. A lost acknowledgement
reuses the same request ID; a broken audio connection never replays old microphone audio or
spoken replies. Unsent transcripts remain visible and can be retried or discarded. Leaving
the conversation releases capture. Browser microphone permission requires HTTPS or localhost.

The voice session has no tools and cannot automatically answer microphone input. Input uses
server VAD with noise reduction and `gpt-transcribe`; the browser requests echo cancellation.
Completed input audio is removed immediately. Spoken output uses explicit text with an
out-of-band response, so the voice model receives no full task history or tool output. Long
replies are read in bounded chunks, and an enabled session is renewed before its time limit.

## Native images and waiting

Direct manual Chat enables Codex's native `image_generation` when the attachment
store is configured, and enables interruptible `sleep_tool`. Both remain disabled
for connection probes, tasks and automations. The current pinned Codex
runtime supports these features; image generation uses the existing ChatGPT login
and allowance. `HOMELAB_MIRA_OPENAI_API_KEY` belongs to voice and is never forwarded
to the Codex child or used as an image fallback.

Matching completed image items are imported through the normal owner-scoped
attachment store before a turn is marked complete. Images are limited to eight
per turn and 25 MiB each, validated as PNG, JPEG or WebP, and subject to the normal
file quotas, message limits, cancellation and lease checks. Provider file references
are confined to the private `generated_images` directory; arbitrary host paths are
rejected. Failed or interrupted image calls are never automatically replayed.
Native base64 image results count toward the existing visual-history budget.
History records allow the bounded image frame plus its envelope; recovery expires
the copied pixels into an explicit text marker before importing context, preserving
the original provider file and any saved attachment.

Other native capabilities remain intentionally disabled: shell/exec, browser,
computer, remote control, connectors/plugins, hooks, workspace installation,
memory and delegation. Mira already owns the relevant permission and execution
paths. Native `view_image` would expose local service files outside the attachment
interface. Experimental `code_mode_tool_search` is unnecessary for Mira's two-entry
discovery/invocation router; `tool_suggest` is for integrations not enabled here.
