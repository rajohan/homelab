import type { SQL } from "bun";
import * as v from "valibot";

import { openBrowserConnection } from "../browsing/connection";
import {
    prepareBrowserContainer,
    type BrowserContainerJournal,
} from "../browsing/container";
import { browserEngine } from "../browsing/engine";
import { openBrowserWorker } from "../browsing/process";
import { reconcileBrowserContainer } from "../browsing/reconciliation";
import { openBrowserSession } from "../browsing/session";
import {
    claimMiraBrowserAccess,
    closeMiraBrowserAccess,
    requireMiraBrowserAccess,
} from "./browserAccess";
import {
    advanceMiraBrowserProcess,
    beginMiraBrowserProcessCleanup,
    claimMiraBrowserProcessRecovery,
    confirmMiraBrowserProcessCleanup,
    renewMiraBrowserProcess,
    recordMiraBrowserProcessCleanup,
    reserveMiraBrowserProcess,
} from "./browserProcesses";
import type { MiraContext } from "./context";

const configurationSchema = v.strictObject({
    hostId: v.pipe(v.string(), v.uuid()),
    socketPath: v.pipe(v.string(), v.minLength(1), v.maxLength(4096)),
    imageId: v.pipe(v.string(), v.regex(/^sha256:[a-f0-9]{64}$/)),
});
type Configuration = v.InferOutput<typeof configurationSchema>;
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
    const config = v.parse(configurationSchema, configuration);
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
    const config = v.parse(configurationSchema, configuration);
    const fixed = { socketPath: config.socketPath, imageId: config.imageId };
    const host: MiraContext = {
        client: context.client,
        owner: context.owner,
        actor: context.actor,
        ...(context.run ? { run: { ...context.run } } : {}),
    };
    await browserEngine(fixed);
    owner.throwIfAborted();
    const access = await claimMiraBrowserAccess(host, id);
    const identity = { id: access.id, hostToken: access.hostToken };
    let record: Awaited<ReturnType<typeof reserveMiraBrowserProcess>>;
    try {
        record = await reserveMiraBrowserProcess(host.client, {
            accessId: access.id,
            hostToken: access.hostToken,
            hostId: config.hostId,
            imageId: config.imageId,
        });
    } catch (error) {
        // No process was dispatched. The cleanup helper refuses an uncertain
        // reservation commit, preserving its slot for normal host recovery.
        await closeMiraBrowserAccess(host, identity);
        throw error;
    }
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
    return openBrowserSession(
        (signal) =>
            (dependencies.open ?? openBrowserWorker)(
                fixed,
                access.policy,
                signal,
                (input, lifetime) =>
                    openBrowserConnection(input, lifetime, {
                        prepare: (input, lifetime) =>
                            (dependencies.prepare ?? prepareBrowserContainer)(
                                input,
                                lifetime,
                                undefined,
                                journal
                            ),
                    })
            ),
        {
            check: async (mode) => {
                await renewMiraBrowserProcess(host.client, claim);
                return requireMiraBrowserAccess(host, { ...identity, mode });
            },
            release: () => cleanup(host.client, config, claim, dependencies.reconcile),
        },
        owner
    );
}
