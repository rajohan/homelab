import type { InfrastructureInventory } from "@homelab/contracts/infrastructure";
import type { SQL } from "bun";
import * as v from "valibot";

import type { JobHandler } from "../../jobs/types";
import {
    collectAvailabilityCheckpoint,
    saveAvailabilityCheckpoint,
} from "./availabilityArchive";
import {
    collectAvailabilityBackfill,
    saveAvailabilityBackfill,
} from "./availabilityBackfill";
import { collectMetrics } from "./collector";
import { collectInventory } from "./inventory";

/**
 * Register the metrics integration without coupling the job engine to its provider.
 * @param configuration - Scoped metrics endpoint settings.
 * @param previous - Loader for the last persisted inventory, including after worker restarts.
 * @param client - Database containing resumable availability recovery progress.
 * @returns A safe, resource-serialized snapshot job and default one-minute schedule.
 */
export function metricsJob(
    configuration: {
        url: string;
        token: string | undefined;
    },
    previous: () => Promise<InfrastructureInventory | null>,
    client: SQL
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
            await context.reportProgress(
                "Collecting infrastructure measurements and inventory."
            );
            const [snapshot, inventory] = await Promise.all([
                collectMetrics(configuration, context.signal),
                previous().then((inventory) =>
                    collectInventory(configuration, context.signal, inventory)
                ),
            ]);
            // Snapshot publication remains available when a dedicated history read fails.
            const [checkpoint, backfill] = await Promise.all([
                collectAvailabilityCheckpoint(
                    configuration,
                    inventory,
                    AbortSignal.any([context.signal, AbortSignal.timeout(5000)])
                ).catch(async () => {
                    await context.reportProgress(
                        "Availability checkpoint unavailable for this minute."
                    );
                    return null;
                }),
                collectAvailabilityBackfill(
                    client,
                    configuration,
                    inventory,
                    AbortSignal.any([context.signal, AbortSignal.timeout(5000)])
                ).catch(() => ({ days: [], failed: 1 })),
            ]);
            if (backfill.failed)
                await context.reportProgress(
                    "Some availability history will be retried on a later run."
                );
            await context.reportProgress("Saving the infrastructure snapshot.");
            if (
                !(await context.commit(async (transaction) => {
                    if (checkpoint)
                        await saveAvailabilityCheckpoint(transaction, checkpoint);
                    await saveAvailabilityBackfill(transaction, backfill.days);
                    await transaction`INSERT INTO operation_snapshots (key, value, captured_at) VALUES ('infrastructure', ${JSON.stringify(snapshot)}::text::jsonb, ${new Date(snapshot.capturedAt)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, captured_at = EXCLUDED.captured_at`;
                    await transaction`INSERT INTO operation_snapshots (key, value, captured_at) VALUES ('infrastructure.inventory', ${JSON.stringify(inventory)}::text::jsonb, ${new Date(inventory.capturedAt)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, captured_at = EXCLUDED.captured_at`;
                }))
            )
                throw new Error("Job ownership changed before snapshot commit");
        },
    };
}
