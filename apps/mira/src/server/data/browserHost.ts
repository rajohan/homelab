import { openBrowserWorker } from "../browsing/process";
import { openBrowserSession } from "../browsing/session";
import {
    claimMiraBrowserAccess,
    closeMiraBrowserAccess,
    requireMiraBrowserAccess,
} from "./browserAccess";
import type { MiraContext } from "./context";

/**
 * Consume an owned run grant and supervise its fixed browser until verified cleanup.
 * @param context - Trusted host identity with the original executor lease; never model-selected.
 * @param id - Human-created grant ID to consume exactly once.
 * @param configuration - Trusted installed immutable image and canonical local Engine socket.
 * @param owner - Host lifetime cancellation; no reconnect or automatic replacement is attempted.
 * @param open - Native factory replacement for isolated qualification only.
 * @returns The guarded browser port, without private claim tokens or database identity.
 */
export async function openMiraBrowserSession(
    context: MiraContext,
    id: string,
    configuration: unknown,
    owner: AbortSignal,
    open: typeof openBrowserWorker = openBrowserWorker
) {
    owner.throwIfAborted();
    const fixed = structuredClone(configuration);
    const host: MiraContext = {
        client: context.client,
        owner: context.owner,
        actor: context.actor,
        ...(context.run ? { run: { ...context.run } } : {}),
    };
    const claim = await claimMiraBrowserAccess(host, id);
    const identity = { id: claim.id, hostToken: claim.hostToken };
    return openBrowserSession(
        (signal) => open(fixed, claim.policy, signal),
        {
            check: (mode) => requireMiraBrowserAccess(host, { ...identity, mode }),
            release: () => closeMiraBrowserAccess(host, identity),
        },
        owner
    );
}
