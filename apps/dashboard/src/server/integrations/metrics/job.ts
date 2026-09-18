import type { InfrastructureInventory } from "@homelab/contracts/infrastructure";
import * as v from "valibot";

import type { JobHandler } from "../../jobs/types";
import { collectMetrics } from "./collector";
import { collectInventory } from "./inventory";

/**
 * Register the metrics integration without coupling the job engine to its provider.
 * @param configuration - Scoped metrics endpoint settings.
 * @param previous - Loader for the last persisted inventory, including after worker restarts.
 * @returns A safe, resource-serialized snapshot job and default one-minute schedule.
 */
export function metricsJob(
    configuration: {
        url: string;
        token: string | undefined;
    },
    previous: () => Promise<InfrastructureInventory | null> = () => Promise.resolve(null)
): JobHandler {
    return {
        definition: {
            key: "infrastructure.metrics",
            label: "Refresh infrastructure summary",
            description:
                "Collect a bounded monitoring snapshot without changing any monitored service.",
            resourceClass: "network",
            capability: "infrastructure:refresh",
            resourceKeys: ["snapshot:infrastructure"],
            timeoutMs: 20_000,
            attemptLimit: 3,
            retrySafe: true,
            intervalSeconds: 60,
            validate: (input) => v.parse(v.strictObject({}), input),
        },
        execute: async (_payload, context) => {
            const [snapshot, inventory] = await Promise.all([
                collectMetrics(configuration, context.signal),
                previous().then((inventory) =>
                    collectInventory(configuration, context.signal, inventory)
                ),
            ]);
            if (
                !(await context.commit(async (transaction) => {
                    await transaction`INSERT INTO operation_snapshots (key, value, captured_at) VALUES ('infrastructure', ${JSON.stringify(snapshot)}::text::jsonb, ${new Date(snapshot.capturedAt)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, captured_at = EXCLUDED.captured_at`;
                    await transaction`INSERT INTO operation_snapshots (key, value, captured_at) VALUES ('infrastructure.inventory', ${JSON.stringify(inventory)}::text::jsonb, ${new Date(inventory.capturedAt)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, captured_at = EXCLUDED.captured_at`;
                }))
            )
                throw new Error("Job ownership changed before snapshot commit");
        },
    };
}
