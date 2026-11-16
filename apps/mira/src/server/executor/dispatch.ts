import { setTimeout as delay } from "node:timers/promises";

import type { MaintenanceGate } from "./maintenanceGate";

/**
 * Dispatch independent runs without waiting for earlier turns to finish.
 * @param options - Fenced admission, current readiness, leased claims and cancellable execution.
 * @returns Completion after dispatch stops and every admitted turn finishes cleanup.
 */
export async function dispatchMiraRuns<Run>(options: {
    signal: AbortSignal;
    maintenance: MaintenanceGate;
    ready: () => boolean;
    claim: () => Promise<Run | null>;
    execute: (run: Run, signal: AbortSignal) => Promise<void>;
}): Promise<void> {
    const failed = new AbortController();
    const signal = AbortSignal.any([options.signal, failed.signal]);
    const active = new Set<Promise<void>>();
    let failure: { error: unknown } | undefined;
    try {
        while (!signal.aborted) {
            if (options.ready()) {
                const admitted = Promise.withResolvers<boolean>();
                const work = options.maintenance
                    .run(async () => {
                        const run = await options.claim();
                        admitted.resolve(run !== null);
                        if (run !== null) await options.execute(run, signal);
                    })
                    .then(
                        () => admitted.resolve(false),
                        (error: unknown) => {
                            failure ??= { error };
                            failed.abort();
                            admitted.resolve(false);
                        }
                    );
                active.add(work);
                void work.then(() => active.delete(work));
                if (await admitted.promise) continue;
            }
            await delay(500, undefined, { signal }).catch((error: unknown) => {
                if (!signal.aborted) throw error;
            });
        }
    } catch (error) {
        failure ??= { error };
        failed.abort();
    } finally {
        await Promise.all(active);
    }
    if (failure) throw failure.error;
}
