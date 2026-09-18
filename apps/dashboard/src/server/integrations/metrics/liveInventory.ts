import type { InfrastructureInventory } from "@homelab/contracts/infrastructure";

/**
 * Share on-demand live reads without scheduling database writes or background work.
 * @param collect - Bounded server-owned collection; failures remain visible to callers.
 * @param now - Monotonic clock in milliseconds, injectable for deterministic tests.
 * @returns A reader sharing pending work and results for five seconds per runtime.
 */
export function createInventoryReader(
    collect: (
        previous: InfrastructureInventory | undefined
    ) => Promise<InfrastructureInventory>,
    now: () => number = () => performance.now()
): () => Promise<InfrastructureInventory> {
    let previous: InfrastructureInventory | undefined;
    let cached:
        | {
              startedAt: number;
              pending: boolean;
              result: Promise<InfrastructureInventory>;
          }
        | undefined;
    return () => {
        if (cached && (cached.pending || now() - cached.startedAt < 5000))
            return cached.result;
        const entry = {
            startedAt: now(),
            pending: true,
            result: Promise.resolve()
                .then(() => collect(previous))
                .then((inventory) => {
                    previous = inventory;
                    return inventory;
                }),
        };
        entry.result = entry.result.finally(() => {
            entry.pending = false;
        });
        cached = entry;
        return entry.result;
    };
}
