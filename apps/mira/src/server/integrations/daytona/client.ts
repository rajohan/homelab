import {
    ApiKeysApiAxiosParamCreator,
    OrganizationsApiAxiosParamCreator,
    SandboxApiAxiosParamCreator,
    SnapshotsApiAxiosParamCreator,
    type CreateSandbox,
} from "@daytona/api-client";
import * as v from "valibot";

import { integrationJson } from "../http";
import {
    daytonaBindingHash,
    daytonaPolicy,
    daytonaSandboxName,
    type DaytonaConfiguration,
} from "./configuration";

const id = v.pipe(v.string(), v.uuid());
const text = (maximum: number) => v.pipe(v.string(), v.maxLength(maximum));
const timestamp = v.pipe(v.string(), v.isoTimestamp());
const sandboxSchema = v.object({
    id,
    name: text(128),
    organizationId: id,
    labels: v.record(text(128), text(512)),
    state: v.optional(text(64), "unknown"),
});
const policySchema = v.object({
    env: v.strictObject({}),
    public: v.literal(false),
    networkBlockAll: v.literal(false),
    networkAllowList: v.nullish(v.literal("")),
    domainAllowList: v.nullish(v.literal("")),
    outboundProxyUrl: v.nullish(v.literal("")),
    kvm: v.literal(false),
    linkedSandboxId: v.nullish(v.literal("")),
    volumes: v.optional(v.pipe(v.array(v.unknown()), v.length(0)), []),
    cpu: v.literal(daytonaPolicy.cpu),
    memory: v.literal(daytonaPolicy.memory),
    disk: v.literal(daytonaPolicy.disk),
    gpu: v.literal(0),
    target: text(64),
    snapshot: text(128),
    autoDeleteInterval: v.literal(0),
    autoStopInterval: v.literal(5),
    autoPauseInterval: v.literal(0),
    createdAt: timestamp,
    autoDestroyAt: timestamp,
});
const snapshotSchema = v.object({
    id,
    organizationId: id,
    general: v.literal(false),
    name: v.pipe(text(128), v.minLength(1)),
    state: v.literal("active"),
    cpu: v.literal(daytonaPolicy.cpu),
    mem: v.literal(daytonaPolicy.memory),
    disk: v.literal(daytonaPolicy.disk),
    gpu: v.literal(0),
    sandboxClass: v.literal("container"),
});
const api = SandboxApiAxiosParamCreator();
const keys = ApiKeysApiAxiosParamCreator();
const organizations = OrganizationsApiAxiosParamCreator();
const snapshots = SnapshotsApiAxiosParamCreator();
type Arguments = Awaited<ReturnType<typeof api.getSandbox>>;
export interface DaytonaReference {
    runId: string;
    sandboxId?: string;
}
export interface DaytonaObservation {
    id: string;
    name: string;
    state: string;
    settingsMatch: boolean;
    createdAt: string | null;
    expiresAt: string | null;
}

/** A provider response cannot prove whether the external mutation completed. Never replay it automatically. */
export class DaytonaUncertainMutation extends Error {
    readonly reference: DaytonaReference;
    /**
     * Retain only the known product/provider identifiers, excluding credential-bearing request details.
     * @param reference - Attempt already persisted by the caller before dispatch.
     */
    constructor(reference: DaytonaReference) {
        super(
            "Daytona did not confirm this attempt. Reconcile the existing sandbox before further work."
        );
        this.name = "DaytonaUncertainMutation";
        this.reference = { ...reference };
    }
}

/** Explicit Daytona control-plane adapter; constructing it performs no I/O or automatic environment lookup. */
export class DaytonaClient {
    private readonly configuration: DaytonaConfiguration;
    private readonly request: typeof fetch;
    /**
     * Bind one operator-owned account to a fixed HTTPS origin and bounded transport.
     * @param configuration - Provisioned account, private snapshot ID and executor-only credential.
     * @param request - Substitute only for synthetic provider qualification.
     */
    constructor(configuration: DaytonaConfiguration, request: typeof fetch = fetch) {
        daytonaBindingHash(configuration);
        if (!/^[\u0021-\u007E]{20,2048}$/.test(configuration.apiKey))
            throw new Error("Invalid Daytona credential.");
        this.configuration = { ...configuration };
        this.request = request;
    }

    private async json(
        args: Arguments,
        signal: AbortSignal,
        missing = false
    ): Promise<unknown> {
        signal.throwIfAborted();
        if (
            !/^\/(?:api-keys\/current|organizations\/[a-zA-Z0-9-]+(?:\/users)?|snapshots\/[a-zA-Z0-9-]+|sandbox(?:\/[a-zA-Z0-9-]+)?)$/.test(
                args.url
            )
        )
            throw new Error("Invalid Daytona control-plane route.");
        const method = args.options.method?.toUpperCase();
        if (!method || !["GET", "POST", "DELETE"].includes(method))
            throw new Error("Invalid Daytona method.");
        const data: unknown = args.options.data;
        if (data !== undefined && typeof data !== "string")
            throw new Error("Invalid Daytona request body.");
        try {
            const response = await this.request(`https://app.daytona.io/api${args.url}`, {
                method,
                headers: {
                    Authorization: `Bearer ${this.configuration.apiKey}`,
                    "X-Daytona-Organization-ID": this.configuration.organizationId,
                    "X-Daytona-Source": "homelab-mira",
                    Accept: "application/json",
                    "Content-Type": "application/json",
                },
                ...(data === undefined ? {} : { body: data }),
                credentials: "omit",
                redirect: "error",
                signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
            });
            if (missing && response.status === 404) {
                await response.body?.cancel();
                return null;
            }
            return await integrationJson(response, 256 * 1024);
        } catch {
            signal.throwIfAborted();
            throw new Error("Daytona request failed or returned an invalid response.");
        }
    }

    private labels(runId: string) {
        return {
            "homelab.owner": daytonaBindingHash(this.configuration),
            "homelab.run": runId,
            "homelab.service": "mira",
        };
    }

    private observation(
        value: unknown,
        reference: DaytonaReference,
        snapshotName?: string
    ): DaytonaObservation {
        const row = v.parse(sandboxSchema, value);
        const labels = this.labels(reference.runId);
        if (
            row.organizationId !== this.configuration.organizationId ||
            row.name !== daytonaSandboxName(this.configuration, reference.runId) ||
            (reference.sandboxId !== undefined && row.id !== reference.sandboxId) ||
            Object.entries(labels).some(([key, expected]) => row.labels[key] !== expected)
        )
            throw new Error("Daytona did not confirm ownership of this sandbox.");
        const policy = v.safeParse(policySchema, value);
        let settingsMatch = false;
        let createdAt: string | null = null,
            expiresAt: string | null = null;
        if (policy.success) {
            const p = policy.output;
            createdAt = p.createdAt;
            expiresAt = p.autoDestroyAt;
            const lifetime = Date.parse(expiresAt) - Date.parse(createdAt);
            settingsMatch =
                p.target === this.configuration.target &&
                (p.snapshot === this.configuration.snapshotId ||
                    p.snapshot === snapshotName) &&
                lifetime > 0 &&
                lifetime <= daytonaPolicy.ttlMinutes * 60_000 &&
                Date.parse(createdAt) <= Date.now() + 30_000 &&
                Date.parse(expiresAt) > Date.now();
        }
        return {
            id: row.id,
            name: row.name,
            state: row.state,
            settingsMatch,
            createdAt,
            expiresAt,
        };
    }

    /**
     * Verify that the actual credential belongs to the expected organization and can remove its sandboxes.
     * @param signal - Cancellation covering both headers and bounded response body.
     * @param creating - Also require create permission and a sole-owner organization before spending resources or executing code.
     * @returns Completion without exposing key metadata or masked credentials.
     */
    async preflight(signal: AbortSignal, creating = false): Promise<void> {
        const row = v.parse(
            v.object({
                organizationId: id,
                userId: v.pipe(text(256), v.minLength(1)),
                permissions: v.pipe(v.array(text(128)), v.maxLength(100)),
                expiresAt: v.nullable(timestamp),
            }),
            await this.json(await keys.getCurrentApiKey(), signal)
        );
        if (
            row.organizationId !== this.configuration.organizationId ||
            !row.permissions.includes("delete:sandboxes") ||
            (creating && !row.permissions.includes("write:sandboxes")) ||
            (row.expiresAt !== null && Date.parse(row.expiresAt) <= Date.now())
        )
            throw new Error(
                "Daytona credential does not match the configured organization or required permissions."
            );
        if (creating) {
            const organization = v.parse(
                v.object({ id, suspended: v.literal(false) }),
                await this.json(
                    await organizations.getOrganization(
                        this.configuration.organizationId
                    ),
                    signal
                )
            );
            const members = v.parse(
                v.pipe(
                    v.array(
                        v.object({
                            organizationId: id,
                            userId: text(256),
                            role: v.literal("owner"),
                        })
                    ),
                    v.length(1)
                ),
                await this.json(
                    await organizations.listOrganizationMembers(
                        this.configuration.organizationId
                    ),
                    signal
                )
            );
            if (
                organization.id !== this.configuration.organizationId ||
                members[0]!.organizationId !== this.configuration.organizationId ||
                members[0]!.userId !== row.userId
            )
                throw new Error(
                    "Daytona requires a dedicated organization with only the credential owner as a member."
                );
        }
    }

    private async snapshot(signal: AbortSignal) {
        const row = v.parse(
            snapshotSchema,
            await this.json(
                await snapshots.getSnapshot(this.configuration.snapshotId),
                signal
            )
        );
        if (
            row.id !== this.configuration.snapshotId ||
            row.organizationId !== this.configuration.organizationId
        )
            throw new Error("Daytona did not confirm the configured private snapshot.");
        return row;
    }

    /**
     * Create one private sandbox with explicitly allowed provider-default networking, fixed resources and a wall-clock TTL.
     * @param runId - Durable unique attempt ID; callers must never call create twice for one attempt.
     * @param signal - Service cancellation; an interrupted POST still has an uncertain external outcome.
     * @param authorize - Last admission check and durable attempt claim, called after provider preflight and before POST.
     * @returns Immediate provider receipt; matching settings are not execution authority. Persist it before continuing.
     */
    async create(
        runId: string,
        signal: AbortSignal,
        authorize: () => Promise<void>
    ): Promise<DaytonaObservation> {
        const name = daytonaSandboxName(this.configuration, runId);
        await this.preflight(signal, true);
        const snapshot = await this.snapshot(signal);
        const body: CreateSandbox = {
            name,
            snapshot: this.configuration.snapshotId,
            target: this.configuration.target,
            labels: this.labels(runId),
            env: {},
            public: false,
            networkBlockAll: false,
            kvm: false,
            volumes: [],
            secrets: [],
            cpu: daytonaPolicy.cpu,
            memory: daytonaPolicy.memory,
            disk: daytonaPolicy.disk,
            gpu: 0,
            autoStopInterval: 5,
            autoPauseInterval: 0,
            autoDeleteInterval: 0,
            ttlMinutes: daytonaPolicy.ttlMinutes,
            queueTimeout: daytonaPolicy.queueTimeout,
        };
        const args = await api.createSandbox(body);
        await authorize();
        signal.throwIfAborted();
        try {
            return this.observation(
                await this.json(args, signal),
                { runId },
                snapshot.name
            );
        } catch {
            throw new DaytonaUncertainMutation({ runId });
        }
    }

    /**
     * Reconcile an existing attempt by its recorded ID or deterministic name after a lost create acknowledgement.
     * @param reference - Durable attempt identity and provider ID when known; never a caller-supplied URL.
     * @param signal - Read cancellation.
     * @returns Owned observation or null on a verified-account 404. Absence alone never authorizes another create.
     */
    async inspect(
        reference: DaytonaReference,
        signal: AbortSignal
    ): Promise<DaytonaObservation | null> {
        const name = daytonaSandboxName(this.configuration, reference.runId);
        if (reference.sandboxId !== undefined) v.parse(id, reference.sandboxId);
        await this.preflight(signal);
        const value = await this.json(
            await api.getSandbox(reference.sandboxId ?? name),
            signal,
            true
        );
        if (value === null) return null;
        const observation = this.observation(value, reference);
        if (observation.settingsMatch) return observation;
        // Some API versions return the snapshot name instead of its immutable ID.
        // Snapshot availability must not prevent identifying and deleting a resource.
        try {
            const snapshot = await this.snapshot(signal);
            return this.observation(value, reference, snapshot.name);
        } catch {
            signal.throwIfAborted();
            return observation;
        }
    }

    /**
     * Request destruction of only this attempt's verified sandbox, including resources with a drifted policy.
     * @param reference - Persisted attempt and optional known provider ID; original binding remains required.
     * @param signal - Cleanup cancellation; callers must reconcile an uncertain DELETE before reporting completion.
     * @returns Absent, confirmed destroyed, or deletion requested; accepting DELETE is not proof of destruction.
     */
    async destroy(
        reference: DaytonaReference,
        signal: AbortSignal
    ): Promise<"absent" | "destroyed" | "requested"> {
        const existing = await this.inspect(reference, signal);
        if (!existing) return "absent";
        if (existing.state === "destroyed") return "destroyed";
        signal.throwIfAborted();
        try {
            const value = await this.json(await api.deleteSandbox(existing.id), signal);
            const receipt = this.observation(value, {
                ...reference,
                sandboxId: existing.id,
            });
            return receipt.state === "destroyed" ? "destroyed" : "requested";
        } catch {
            throw new DaytonaUncertainMutation({ ...reference, sandboxId: existing.id });
        }
    }
}
