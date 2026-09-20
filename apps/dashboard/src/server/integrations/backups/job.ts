import type { BackupInventory } from "@homelab/contracts/backups";
import * as v from "valibot";

import type { JobHandler } from "../../jobs/types";
import type { MetricsConfiguration } from "../metrics/transport";
import { collectBackups } from "./inventory";

/**
 * Register backup observation independently of infrastructure and application collection.
 * @param configuration - Read-only monitoring configuration.
 * @param previous - Last persisted inventory, used only to retain unavailable identities.
 * @returns An hourly-policy-independent one-minute backup status collector.
 */
export function backupsJob(
    configuration: MetricsConfiguration,
    previous: () => Promise<BackupInventory | null>
): JobHandler {
    return {
        definition: {
            key: "backups.status",
            label: "Refresh backup status",
            description:
                "Read backup completion, verification and freshness from monitoring.",
            resourceClass: "network",
            capability: "backups:refresh",
            resourceKeys: ["snapshot:backups"],
            timeoutMs: 20_000,
            attemptLimit: 3,
            retrySafe: true,
            intervalSeconds: 60,
            validate: (input) => v.parse(v.strictObject({}), input),
        },
        execute: async (_payload, context) => {
            await context.reportProgress("Reading backup and verification status.");
            const inventory = await collectBackups(
                configuration,
                await previous(),
                context.signal
            );
            if (
                !(await context.commit(async (transaction) => {
                    await transaction`INSERT INTO operation_snapshots (key, value, captured_at) VALUES ('backups', ${JSON.stringify(inventory)}::text::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, captured_at = EXCLUDED.captured_at`;
                }))
            )
                throw new Error("Backup collection ownership changed");
            await context.reportProgress("Backup status refreshed.");
        },
    };
}
