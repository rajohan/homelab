import type { Capability } from "@homelab/contracts/operations";
import * as v from "valibot";

import type { JobHandler } from "../../jobs/types";

/**
 * Register a read-only inventory whose snapshot is replaced only by a complete owned run.
 * @param settings - Code-owned job identity, cadence and bounded reader.
 * @returns An independent, retry-safe job with the existing claim fence.
 */
export function snapshotJob<T>(settings: {
    readonly key: string;
    readonly label: string;
    readonly description: string;
    readonly capability: Capability;
    readonly intervalSeconds: number;
    readonly read: (signal: AbortSignal) => Promise<T>;
}): JobHandler {
    return {
        definition: {
            key: settings.key,
            label: settings.label,
            description: settings.description,
            capability: settings.capability,
            intervalSeconds: settings.intervalSeconds,
            resourceClass: "network",
            resourceKeys: [`snapshot:${settings.key}`],
            timeoutMs: 30_000,
            attemptLimit: 3,
            retrySafe: true,
            validate: (input) => v.parse(v.strictObject({}), input),
        },
        execute: async (_payload, context) => {
            await context.reportProgress(settings.description);
            const inventory = await settings.read(context.signal);
            if (
                !(await context.commit(async (transaction) => {
                    await transaction`INSERT INTO operation_snapshots (key, value, captured_at) VALUES (${settings.key}, ${JSON.stringify(inventory)}::text::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, captured_at = EXCLUDED.captured_at`;
                }))
            )
                throw new Error("Inventory collection ownership changed");
            await context.reportProgress("Inventory refreshed.");
        },
    };
}
