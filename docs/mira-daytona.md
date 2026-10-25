# Daytona adapter qualification

The first Daytona delivery adds the control-plane adapter only. It is not registered in the executor, scheduler, chat tools or dashboard routes, and it creates no resources at startup. Durable admission, execution, logs, artifacts, cancellation UI and production activation follow in a separate reviewed change. This document is not a claim that the full Daytona integration is deployed.

## Version and transport

Mira pins the official `@daytona/api-client` at `0.226.1` in its Bun workspace. The existing weekly Bun Dependabot group includes it; dependency changes follow the existing `chore(deps)` patch-release policy. No third-party package is patched. The generated request-parameter builders provide the current API routes and typed payloads; Homelab sends those requests using its bounded fetch transport. It does not instantiate the high-level SDK, inherit its dotenv configuration, initialize telemetry or start background sockets. Requests use the fixed `https://app.daytona.io/api` origin, reject redirects, omit cookies, cap metadata at 256 KiB and bound headers plus body delivery to 15 seconds. They are not automatically retried.

The reviewed official SDK `0.226.1` uses connection retry rules, automatic environment discovery and optional telemetry. Its explicit `otelEnabled: false` does not override an environment value of `true`. The generated client avoids importing those runtime behaviors without a local patch. See the [official clients](https://github.com/daytona/clients) and [Daytona API](https://www.daytona.io/docs/en/api/).

## Provisioning contract

The adapter parser accepts only these explicit executor settings. They are not yet wired into the service environment or deployment examples:

- `HOMELAB_MIRA_DAYTONA_OWNER`: Homelab owner subject.
- `HOMELAB_MIRA_DAYTONA_ORGANIZATION_ID`: exact provider organization UUID.
- `HOMELAB_MIRA_DAYTONA_SNAPSHOT_ID`: exact private snapshot UUID, not a mutable name or default image.
- `HOMELAB_MIRA_DAYTONA_TARGET`: selected provider region.
- `HOMELAB_MIRA_DAYTONA_API_KEY`: executor-only credential. It never enters the model environment or sandbox payload.

Before creation, `/api-keys/current` must confirm the configured organization, a live credential and both `write:sandboxes` and `delete:sandboxes`. The private snapshot must belong to that organization, be active, use the container class, and declare exactly 2 CPU, 4 GiB memory, 10 GiB disk and no GPU. An immutable, clean snapshot with Bun 1.4.4 and the qualified execution harness must be provisioned and checked before activation. Metadata alone does not prove the installed Bun version or absence of baked-in secrets. No live account or snapshot has been qualified by this change.

Create requests specify those resource limits, no volume mounts, no linked sandbox, no mounted secrets, no host environment, no KVM, private previews and `networkBlockAll: true`. Package installation and remote Git fetches are consequently unavailable inside this initial isolated policy; the execution delivery must select and transfer only approved inputs or use a separately reviewed network policy. All settings are included in the binding fingerprint, while credential rotation within the same organization preserves it.

The provider receives a 15-minute wall-clock TTL, 2-minute queue timeout request, 5-minute idle stop and immediate deletion after stop. [Daytona's lifecycle contract](https://www.daytona.io/docs/en/typescript-sdk/daytona/) distinguishes TTL from idle stop/delete; TTL applies regardless of sandbox state. Queue timeout is only honored when the organization enables its queue-timeout feature. The TTL is the independent resource bound. Provider billing and aggregate daily spending limits still require the durable queue layer and account qualification; this adapter does not claim to enforce a currency budget.

## Caller obligations and recovery

A future durable dispatcher must persist the immutable binding, a unique attempt UUID and create-attempt state before invoking the final `authorize` callback. The callback must atomically recheck owner controls, lease, approval/admission policy and concurrency/spend limits. Call `create` at most once for that attempt. The adapter performs account/snapshot preflight before this callback and immediately returns the create receipt without waiting for readiness. Persist the returned provider ID before any subsequent step.

A deterministic `mira-<binding-prefix>-<attempt-UUID>` name and full binding/attempt labels allow `inspect` to find an already created sandbox after an acknowledgement is lost. Account, name, labels and any recorded provider ID must all agree before accepting an observation or sending DELETE. A timeout, cancellation during dispatch, HTTP error or malformed mutation response produces `DaytonaUncertainMutation`; it must never return to an automatic create/replay path. Even a subsequent 404 does not prove that a timed-out creation cannot still appear. Retain unresolved attempts for reconciliation through their expected lifetime and report uncertainty rather than freeing the admission slot early.

`policySatisfied` means the observed environment is explicitly empty and the isolation, resources, account region, snapshot and remaining TTL match. Missing or nonempty `env` is a policy failure, including opaque provider secret placeholders. It is separate from readiness: callers must also require `state === "started"` and qualify the runtime before code execution. Unknown states are observations, never success. Missing or drifted policy fields prevent execution but do not block deletion of a resource whose ownership remains verified. Snapshot lookup failure similarly cannot strand owned cleanup. Retain the original binding for cleanup after an operator changes the active configuration.

`destroy` distinguishes an absent resource, a confirmed `destroyed` state and a merely accepted deletion request. A successful DELETE request is not completion. Poll until absence/destruction is confirmed; uncertain DELETE responses retain the known provider ID. Cleanup must remain possible while new admissions are paused, and TTL is a fallback if the executor disappears. No host command execution, SSH keys, credentials or private repository export is provided by this adapter.

## Validation

Synthetic tests exercise account and snapshot disagreement, final admission revocation, cancellation before and during dispatch, uncertain writes with no replay, deterministic recovery, cross-owner/ID rejection, policy drift, cleanup during snapshot outages, explicit deletion outcomes, private response-field omission, and advertised/streamed response limits. These tests use the actual generated request builders and an injected provider transport. They incur no Daytona usage and do not replace later live qualification.
