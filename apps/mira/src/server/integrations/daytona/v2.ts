import * as v from "valibot";

import { integrationJson } from "../http";
import {
    daytonaBindingHash,
    type DaytonaConfiguration,
    daytonaPolicy,
    daytonaSandboxName,
} from "./configuration";
import { type DaytonaReference, DaytonaUncertainMutation } from "./controlPlane";

const sandboxId = v.pipe(v.string(), v.regex(/^sbx_[A-Za-z0-9_-]{1,180}$/));
const idleSeconds = daytonaPolicy.idleMinutes * 60;
const origin = "https://api.daytona.com";
/** A nonsecret operator-facing refusal raised before any sandbox is requested. */
export class DaytonaV2SetupError extends Error {}
const keySchema = v.object({
    project_id: v.string(),
    context: v.object({ org_id: v.string() }),
    project_permissions: v.array(v.string()),
    revoked_at: v.nullish(v.string()),
    expires_at: v.nullish(v.pipe(v.string(), v.isoTimestamp())),
});
const resourceSchema = v.object({
    id: sandboxId,
    name: v.string(),
    status: v.string(),
    labels: v.record(v.string(), v.string()),
    class: v.string(),
    image: v.nullish(v.object({ id: v.string() })),
    region_id: v.string(),
    cpu: v.number(),
    cores_max: v.number(),
    memory_mib: v.number(),
    disk_mib: v.number(),
    disk_max_mib: v.nullish(v.number()),
    memory_max_mib: v.nullish(v.number()),
    persistent: v.nullish(v.boolean()),
    port_map: v.array(v.unknown()),
    created_at: v.nullish(v.string()),
    toolbox_proxy_url: v.nullish(v.string()),
    lifecycle_policy: v.nullish(
        v.object({
            idle_expiry_seconds: v.nullish(v.number()),
            on_idle_timeout: v.nullish(v.string()),
            idle_timeout_at: v.nullish(v.string()),
        })
    ),
});

/** Daytona v2 control plane for a single immutable, operator-qualified project binding. */
export class DaytonaV2 {
    private readonly config: DaytonaConfiguration;
    private readonly request: typeof fetch;
    private readonly ownershipHash: string;
    /** Create a bounded transport with no network activity or ambient credentials.
     * @param config - Provisioned organization, project, private image, region and API credential.
     * @param request - HTTP transport for the official API.
     * @param ownershipHash - Original persisted attempt's policy fingerprint.
     */
    constructor(
        config: DaytonaConfiguration,
        request: typeof fetch,
        ownershipHash: string
    ) {
        this.config = config;
        this.request = request;
        this.ownershipHash = ownershipHash;
    }

    private async response(
        path: string,
        signal: AbortSignal,
        method = "GET",
        data?: unknown
    ) {
        return this.request(origin + path, {
            method,
            redirect: "error",
            credentials: "omit",
            headers: {
                Authorization: `Bearer ${this.config.apiKey}`,
                Accept: "application/json",
                "Content-Type": "application/json",
                "X-Daytona-Region": this.config.target,
            },
            ...(data === undefined ? {} : { body: JSON.stringify(data) }),
            signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
        });
    }

    private async read(path: string, signal: AbortSignal) {
        const response = await this.response(path, signal);
        if (response.status === 401 || response.status === 403) {
            await response.body?.cancel();
            throw new DaytonaV2SetupError(
                "Daytona v2 refused the project credential or its permissions. Review its v2 project and scopes."
            );
        }
        return integrationJson(response, 256 * 1024);
    }

    private async credential(signal: AbortSignal, writing: boolean) {
        const key = v.parse(keySchema, await this.read("/api-keys/current", signal));
        const required = writing
            ? ["read:images", "read:sandboxes", "write:sandboxes", "delete:sandboxes"]
            : ["read:sandboxes", "delete:sandboxes"];
        if (
            !this.config.projectId ||
            key.project_id !== this.config.projectId ||
            key.context.org_id !== this.config.organizationId ||
            key.revoked_at ||
            (key.expires_at && Date.parse(key.expires_at) <= Date.now()) ||
            required.some((scope) => !key.project_permissions.includes(scope))
        )
            throw new DaytonaV2SetupError(
                "Daytona v2 key does not match the approved project or permissions."
            );
    }

    private async preflight(signal: AbortSignal) {
        if (daytonaBindingHash(this.config) !== this.ownershipHash)
            throw new Error("Daytona v2 execution binding changed.");
        await this.credential(signal, true);
        // Personal organizations have one owner. A project key cannot enumerate members of a team.
        if (
            !v.safeParse(
                v.object({ personal: v.literal(true) }),
                await this.read("/migration/v0/summary", signal)
            ).success
        )
            throw new DaytonaV2SetupError(
                "Daytona could not verify a single-owner organization for the configured project."
            );
    }

    /** Allocate one sandbox after verifying the exact image, project and durable consent.
     * @param runId - Stable attempt identity and provider idempotency key.
     * @param signal - Cancellation for this phase.
     * @param authorize - Persist the create attempt and recheck policy immediately before dispatch.
     * @returns Acknowledged provider sandbox ID.
     */
    async create(runId: string, signal: AbortSignal, authorize: () => Promise<void>) {
        await this.preflight(signal);
        const image = v.safeParse(
            v.object({
                id: v.literal(this.config.snapshotId),
                class: v.literal("linux"),
                status: v.literal("ready"),
                platform: v.literal(false),
                deprecated: v.literal(false),
                format_outdated: v.literal(false),
            }),
            await this.read(
                `/images/${encodeURIComponent(this.config.snapshotId)}`,
                signal
            )
        );
        if (!image.success)
            throw new DaytonaV2SetupError(
                "Daytona could not verify the qualified private Linux image. Check the image ID, conversion and readiness."
            );
        const name = daytonaSandboxName(this.config, runId, this.ownershipHash);
        const data = {
            name,
            idempotency_key: runId,
            image: image.output.id,
            region_id: this.config.target,
            wait_seconds: 0,
            cpu: daytonaPolicy.cpu,
            cores_max: daytonaPolicy.cpu,
            memory_mib: daytonaPolicy.memory * 1024,
            memory_max_mib: daytonaPolicy.memory * 1024,
            disk_mib: daytonaPolicy.disk * 1024,
            disk_max_mib: daytonaPolicy.disk * 1024,
            env: {},
            volumes: [],
            ports: [],
            secrets: [],
            labels: {
                name,
                "homelab.binding": this.ownershipHash,
                "homelab.attempt": runId,
            },
            lifecycle_policy: {
                idle_expiry_seconds: idleSeconds,
                on_idle_timeout: "delete",
            },
        };
        await authorize();
        try {
            return v.parse(
                v.object({ id: sandboxId, name: v.literal(name) }),
                await integrationJson(
                    await this.response("/sandboxes", signal, "POST", data),
                    64 * 1024
                )
            );
        } catch {
            throw new DaytonaUncertainMutation({ runId });
        }
    }

    /** Observe the original resource, resolving an unacknowledged creation by exact labels.
     * @param reference - Attempt and optional durable provider ID.
     * @param signal - Cancellation for bounded reads.
     * @returns Verified ownership and settings, or null when no matching sandbox was observed.
     */
    async inspect(reference: DaytonaReference, signal: AbortSignal) {
        await this.credential(signal, false);
        const name = daytonaSandboxName(this.config, reference.runId, this.ownershipHash);
        let id = reference.sandboxId;
        if (!id) {
            const labels = JSON.stringify({
                name,
                "homelab.binding": this.ownershipHash,
                "homelab.attempt": reference.runId,
            });
            const list = v.parse(
                v.object({
                    sandboxes: v.pipe(
                        v.array(v.object({ id: sandboxId })),
                        v.maxLength(1)
                    ),
                    next_cursor: v.nullish(v.never()),
                }),
                await this.read(
                    "/sandboxes/search?" +
                        new URLSearchParams({ labels, limit: "2" }).toString(),
                    signal
                )
            );
            id = list.sandboxes[0]?.id;
            if (!id) return null;
        }
        const response = await this.response(
            `/sandboxes/${v.parse(sandboxId, id)}`,
            signal
        );
        if (response.status === 404) {
            await response.body?.cancel();
            return null;
        }
        const s = v.parse(resourceSchema, await integrationJson(response, 256 * 1024));
        if (
            s.id !== id ||
            s.name !== name ||
            s.labels["homelab.binding"] !== this.ownershipHash ||
            s.labels["homelab.attempt"] !== reference.runId
        )
            throw new Error("Daytona v2 sandbox ownership could not be confirmed.");
        let state = s.status;
        if (state === "running") state = "started";
        else if (state === "deleted") state = "destroyed";
        const policy = s.lifecycle_policy;
        const settingsMatch =
            s.class === "linux" &&
            s.image?.id === this.config.snapshotId &&
            s.region_id === this.config.target &&
            s.cpu === daytonaPolicy.cpu &&
            s.cores_max === daytonaPolicy.cpu &&
            s.memory_mib === daytonaPolicy.memory * 1024 &&
            (s.memory_max_mib ?? s.memory_mib) === s.memory_mib &&
            s.disk_mib === daytonaPolicy.disk * 1024 &&
            (s.disk_max_mib ?? s.disk_mib) === s.disk_mib &&
            s.persistent !== true &&
            s.port_map.length === 0 &&
            policy?.idle_expiry_seconds === idleSeconds &&
            policy.on_idle_timeout === "delete";
        return {
            id,
            name,
            state,
            settingsMatch,
            createdAt: s.created_at ?? null,
            expiresAt: policy?.idle_timeout_at ?? null,
            proxy: s.toolbox_proxy_url,
        };
    }

    /** Refresh the provider idle timer after a live check of the original consent.
     * @param reference - Persisted provider ID and attempt.
     * @param signal - Cancellation covering the request.
     * @param authorize - Recheck the lease and record the new idle deadline.
     */
    async refreshActivity(
        reference: Required<DaytonaReference>,
        signal: AbortSignal,
        authorize: () => Promise<void>
    ) {
        await this.preflight(signal);
        const s = await this.inspect(reference, signal);
        if (!s?.settingsMatch || s.state !== "started")
            throw new Error("Daytona sandbox is unavailable.");
        await authorize();
        await integrationJson(
            await this.response(`/sandboxes/${s.id}/reset-idle-timer`, signal, "POST"),
            16 * 1024
        );
    }

    /** Release the exact sandbox. Confirmation still requires a subsequent read.
     * @param reference - Original attempt and provider ID when known.
     * @param signal - Cancellation covering lookup and deletion.
     * @param authorize - Persist deletion intent before sending it.
     * @returns Provider disposition, separately reconciled before releasing capacity.
     */
    async destroy(
        reference: DaytonaReference,
        signal: AbortSignal,
        authorize: () => Promise<void>
    ): Promise<"absent" | "destroyed" | "requested"> {
        const existing = await this.inspect(reference, signal);
        if (!existing) return "absent";
        if (existing.state === "destroyed") return "destroyed";
        await authorize();
        const response = await this.response(
            `/sandboxes/${existing.id}`,
            signal,
            "DELETE"
        );
        await response.body?.cancel();
        if (!response.ok) throw new DaytonaUncertainMutation(reference);
        return "requested";
    }

    /** Mint a short-lived token scoped to one toolbox and one operation family.
     * @param reference - Exact original sandbox.
     * @param operation - Process or file access required by the caller.
     * @param signal - Cancellation for credential and sandbox checks.
     * @returns Official regional toolbox address, scoped token and verified idle deadline.
     */
    async toolbox(
        reference: Required<DaytonaReference>,
        operation: "toolbox:exec" | "toolbox:fs",
        signal: AbortSignal
    ) {
        await this.preflight(signal);
        const s = await this.inspect(reference, signal);
        if (
            !s?.settingsMatch ||
            s.state !== "started" ||
            !s.proxy ||
            !s.expiresAt ||
            !Number.isFinite(Date.parse(s.expiresAt)) ||
            Date.parse(s.expiresAt) <= Date.now() + 30_000
        )
            throw new Error("Daytona sandbox is unavailable.");
        const proxy = new URL(s.proxy);
        if (
            proxy.protocol !== "https:" ||
            !/^proxy(?:\.[a-z0-9-]+)+\.daytona\.app$/.test(proxy.hostname) ||
            proxy.port ||
            proxy.username ||
            proxy.password ||
            proxy.search ||
            proxy.hash ||
            proxy.pathname !== "/toolbox"
        )
            throw new Error("Unexpected Daytona regional toolbox address.");
        const token = v.parse(
            v.object({
                access_token: v.pipe(v.string(), v.minLength(1), v.maxLength(16_384)),
                operations: v.tuple([v.literal(operation)]),
            }),
            await integrationJson(
                await this.response(`/sandboxes/${s.id}/access-token`, signal, "POST", {
                    operations: [operation],
                    ttl_seconds: 60,
                    ports: [],
                }),
                32 * 1024
            )
        );
        return {
            url: proxy.href + "/" + s.id,
            token: token.access_token,
            deadline: Date.parse(s.expiresAt),
        };
    }
}
