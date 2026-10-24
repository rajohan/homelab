# Mira runtime qualification

`apps/mira` introduces a server-only Codex app-server pilot. It is not yet a deployed
assistant service. There is no public port, dashboard API, production scheduler or
automatic tool access in this change. Auth and dashboard builds remain independent.

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

- Persist product conversations, turns and outcomes separately from provider IDs;
  reconcile uncertain outcomes rather than replaying actions after a timeout.
- Add authenticated dashboard transport, typed operations and durable tool receipts.
  Replace the pilot-only instructions and synthetic registry with scoped services.
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
