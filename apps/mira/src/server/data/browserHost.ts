import type { SQL } from "bun";
import * as v from "valibot";

import { openBrowserConnection } from "../browsing/connection";
import {
    prepareBrowserContainer,
    type BrowserContainerJournal,
} from "../browsing/container";
import { browserEgressSchema } from "../browsing/egress";
import { browserEngine } from "../browsing/engine";
import { openBrowserWorker } from "../browsing/process";
import { reconcileBrowserContainer } from "../browsing/reconciliation";
import { openBrowserSession } from "../browsing/session";
import { claimMiraBrowserAccess, requireMiraBrowserAccess } from "./browserAccess";
import {
    advanceMiraBrowserProcess,
    beginMiraBrowserProcessCleanup,
    claimMiraBrowserProcessRecovery,
    confirmMiraBrowserProcessCleanup,
    renewMiraBrowserProcess,
    recordMiraBrowserProcessCleanup,
    reserveMiraBrowserProcess,
} from "./browserProcesses";
import { prepareMiraBrowserProfile } from "./browserProfileHost";
import type { MiraContext } from "./context";

export const browserHostConfigurationSchema = v.strictObject({
    hostId: v.pipe(v.string(), v.uuid()),
    socketPath: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
    imageId: v.pipe(v.string(), v.regex(/^sha256:[a-f0-9]{64}$/)),
    networks: v.optional(
        v.pipe(
            v.array(browserEgressSchema),
            v.minLength(1),
            v.maxLength(2),
            v.check(
                (values) =>
                    new Set(values.map((item) => item.networkId)).size ===
                        values.length &&
                    new Set(values.map((item) => item.proxyId)).size === values.length
            )
        )
    ),
});
type Configuration = v.InferOutput<typeof browserHostConfigurationSchema>;
type Claim = Awaited<ReturnType<typeof reserveMiraBrowserProcess>>["claim"];
interface Dependencies {
    open?: typeof openBrowserWorker;
    prepare?: typeof prepareBrowserContainer;
    reconcile?: typeof reconcileBrowserContainer;
}
async function cleanup(
    client: SQL,
    config: Configuration,
    claim: Claim,
    reconcile = reconcileBrowserContainer
) {
    if (claim.hostId !== config.hostId)
        throw new Error("Browser recovery belongs to a different host.");
    const record = await beginMiraBrowserProcessCleanup(client, claim);
    if (record.state === "removed") return;
    const proof = await reconcile(
        { socketPath: config.socketPath, imageId: record.imageId },
        { id: record.id, phase: record.phase, containerId: record.containerId },
        async () => {
            await beginMiraBrowserProcessCleanup(client, claim);
        },
        async (containerId) => {
            await recordMiraBrowserProcessCleanup(client, claim, {
                kind: "discovered",
                containerId,
            });
        }
    );
    await confirmMiraBrowserProcessCleanup(client, claim, proof);
}

/**
 * Recover up to two expired processes belonging to this configured local Docker engine.
 * @param client - Trusted host database connection, never a model-facing API.
 * @param configuration - Stable host UUID, canonical local socket and installed image selection.
 * @param reconcile - Synthetic reconciliation replacement for isolated qualification only.
 * @returns Cleanup counts; unresolved creation retains its slot and never starts or replays work.
 */
export async function recoverMiraBrowserProcesses(
    client: SQL,
    configuration: unknown,
    reconcile = reconcileBrowserContainer
) {
    const config = v.parse(browserHostConfigurationSchema, configuration);
    await browserEngine({ socketPath: config.socketPath, imageId: config.imageId });
    let recovered = 0,
        unresolved = 0;
    for (let index = 0; index < 2; index++) {
        const record = await claimMiraBrowserProcessRecovery(client, config.hostId);
        if (!record) break;
        try {
            await cleanup(client, config, record.claim, reconcile);
            recovered++;
        } catch {
            unresolved++;
        }
    }
    return { recovered, unresolved };
}

/**
 * Consume one human grant and bind its durable process identity to the supervised Docker lifetime.
 * @param context - Trusted host retaining the original owner and executor lease, never model-selected.
 * @param id - Human-created grant ID, consumed once before reserving global process capacity.
 * @param configuration - Stable host UUID, local Engine socket and installed immutable image ID.
 * @param owner - Permanent host/run cancellation throughout startup, idle time and operations.
 * @param dependencies - Synthetic native factories for isolated qualification only.
 * @returns A guarded browser port; private grant/controller tokens never leave this boundary.
 */
export async function openMiraBrowserSession(
    context: MiraContext,
    id: string,
    configuration: unknown,
    owner: AbortSignal,
    dependencies: Dependencies = {}
) {
    owner.throwIfAborted();
    const config = v.parse(browserHostConfigurationSchema, configuration);
    const engineConfig = { socketPath: config.socketPath, imageId: config.imageId };
    const host: MiraContext = {
        client: context.client,
        owner: context.owner,
        actor: context.actor,
        ...(context.run ? { run: { ...context.run } } : {}),
    };
    await browserEngine(engineConfig);
    owner.throwIfAborted();
    // Grant consumption and process reservation commit together. A host crash
    // cannot strand an active grant without a recoverable process record.
    const { access, record } = await host.client.begin(async (query) => {
        await query`SELECT pg_advisory_xact_lock(hashtextextended('mira:browser:capacity',0))`;
        const access = await claimMiraBrowserAccess({ ...host, transaction: query }, id);
        const record = await reserveMiraBrowserProcess(
            host.client,
            {
                accessId: access.id,
                hostToken: access.hostToken,
                hostId: config.hostId,
                imageId: config.imageId,
                ...(config.networks
                    ? { networkIds: config.networks.map((network) => network.networkId) }
                    : {}),
            },
            query
        );
        return { access, record };
    });
    const egress = config.networks?.find(
        (network) => network.networkId === record.networkId
    );
    const fixed = { ...engineConfig, ...(egress ? { egress } : {}) };
    const identity = { id: access.id, hostToken: access.hostToken };
    const { claim } = record;
    const journal: BrowserContainerJournal = {
        owner: record.id,
        creating: async () => {
            await advanceMiraBrowserProcess(host.client, claim, { phase: "creating" });
        },
        created: async (containerId) => {
            await advanceMiraBrowserProcess(host.client, claim, {
                phase: "created",
                containerId,
            });
        },
        rejected: async (status) => {
            await beginMiraBrowserProcessCleanup(host.client, claim);
            await recordMiraBrowserProcessCleanup(host.client, claim, {
                kind: "rejected",
                status,
            });
        },
        discovered: async (containerId) => {
            await beginMiraBrowserProcessCleanup(host.client, claim);
            await recordMiraBrowserProcessCleanup(host.client, claim, {
                kind: "discovered",
                containerId,
            });
        },
        starting: async () => {
            await renewMiraBrowserProcess(host.client, claim);
        },
        cleaning: async () => {
            await beginMiraBrowserProcessCleanup(host.client, claim);
        },
        cleaned: async (proof) => {
            await beginMiraBrowserProcessCleanup(host.client, claim);
            await confirmMiraBrowserProcessCleanup(host.client, claim, proof);
        },
    };
    const session = await openBrowserSession(
        async (signal) => {
            const profile = await prepareMiraBrowserProfile(host.client, claim);
            signal.throwIfAborted();
            return (dependencies.open ?? openBrowserWorker)(
                { ...fixed, ...(profile ? { profile: { id: profile.id } } : {}) },
                {
                    ...access.policy,
                    ...(access.policy.mode === "control" &&
                    access.policy.origins.length === 1
                        ? { uploads: true }
                        : {}),
                },
                signal,
                (input, lifetime) =>
                    openBrowserConnection(input, lifetime, {
                        ...(profile ? { profile: profile.persistence } : {}),
                        prepare: (input, lifetime) =>
                            (dependencies.prepare ?? prepareBrowserContainer)(
                                input,
                                lifetime,
                                undefined,
                                journal
                            ),
                    })
            );
        },
        {
            check: async (mode) => {
                await renewMiraBrowserProcess(host.client, claim);
                return requireMiraBrowserAccess(host, { ...identity, mode });
            },
            release: () => cleanup(host.client, config, claim, dependencies.reconcile),
        },
        owner
    );
    return { ...session, claim: { ...record.claim } };
}
