import * as v from "valibot";

import type { JobHandler } from "../../jobs/types";
import { synchronizeAlerts } from "./synchronize";
import { readAlerts, type AlertsConfiguration } from "./transport";

/**
 * Register independent read-only incident collection with fenced state transitions.
 * @param configuration - Deployment-owned Alertmanager read settings.
 * @returns An independently scheduled collector; failures never resolve active incidents.
 */
export function alertsJob(configuration: AlertsConfiguration): JobHandler {
    return {
        definition: {
            key: "monitoring.alerts",
            label: "Refresh monitoring incidents",
            description:
                "Synchronize active, suppressed and resolved monitoring incidents.",
            resourceClass: "network",
            capability: "alerts:refresh",
            resourceKeys: ["snapshot:alerts"],
            timeoutMs: 20_000,
            attemptLimit: 3,
            retrySafe: true,
            intervalSeconds: 60,
            validate: (input) => v.parse(v.strictObject({}), input),
        },
        execute: async (_payload, context) => {
            await context.reportProgress("Reading current monitoring incidents.");
            const alerts = await readAlerts(configuration, context.signal);
            if (
                !(await context.commit((transaction) =>
                    synchronizeAlerts(transaction, alerts)
                ))
            )
                throw new Error("Incident collection ownership changed");
            await context.reportProgress("Monitoring incidents synchronized.");
        },
    };
}
