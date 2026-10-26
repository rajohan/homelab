import { setTimeout as delay } from "node:timers/promises";

import { RuntimeCleanupError } from "../runtime/rpcProcess";
import { type ComputerCompanion, ComputerConnectionError } from "./companion";
import { ComputerConsentController, type ComputerConsentHost } from "./companionConsent";

/**
 * Own sequential local consent attempts for exactly one outbound connection generation.
 * @param options - Fixed connection/credential, trusted local host factory and accepted-session work.
 * @returns Completion only after cancellation and confirmed local cleanup; failures block replacement.
 */
export async function runComputerConsentLoop(options: {
    companion: ComputerCompanion;
    credential: string;
    connectionId: string;
    signal: AbortSignal;
    createHost: () => ComputerConsentHost;
    runSession: (
        controller: ComputerConsentController,
        signal: AbortSignal
    ) => Promise<void>;
    wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
}): Promise<void> {
    const wait =
        options.wait ??
        ((milliseconds, signal) => delay(milliseconds, undefined, { signal }));
    const seen = new Set<string>();
    try {
        while (!options.signal.aborted) {
            const controller = new ComputerConsentController({
                companion: options.companion,
                credential: options.credential,
                connectionId: options.connectionId,
                signal: options.signal,
                host: options.createHost(),
                claimRequest(id) {
                    if (seen.has(id)) return false;
                    // No eviction: a server replay cannot re-open consent after an uncertain stop.
                    if (seen.size >= 16_384) throw new ComputerConnectionError(false);
                    seen.add(id);
                    return true;
                },
            });
            try {
                while (!options.signal.aborted && !controller.signal.aborted) {
                    if (await controller.review()) {
                        await options.runSession(controller, controller.signal);
                        break;
                    }
                    if (!controller.signal.aborted) await wait(2000, options.signal);
                }
            } catch (error) {
                if (error instanceof RuntimeCleanupError) throw error;
                if (
                    !options.signal.aborted &&
                    (error instanceof ComputerConnectionError ||
                        !controller.signal.aborted)
                )
                    throw error;
            } finally {
                await closeController(controller);
            }
            if (!options.signal.aborted) await wait(2000, options.signal);
        }
    } catch (error) {
        if (error instanceof RuntimeCleanupError || !options.signal.aborted) throw error;
    }
}

async function closeController(controller: ComputerConsentController): Promise<void> {
    try {
        await controller.close();
    } catch {
        throw new RuntimeCleanupError();
    }
}
