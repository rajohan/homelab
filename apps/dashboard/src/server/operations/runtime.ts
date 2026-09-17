import type { OperationsConfiguration } from "../config/operations";
import { connectDashboardDatabase } from "../database/connection";
import { metricsJob } from "../integrations/metrics/job";
import { maintenanceJob } from "../jobs/maintenance";
import { createJobRegistry } from "../jobs/registry";

/**
 * Compose explicit operation modules for one dashboard or worker process.
 * @param configuration - Validated scoped deployment settings.
 * @returns Database ownership and executable inventory; the caller closes the pool.
 */
export function createOperationsRuntime(configuration: OperationsConfiguration) {
    const connection = connectDashboardDatabase(configuration.databaseUrl);
    const registry = createJobRegistry([
        maintenanceJob(configuration.retentionDays),
        ...(configuration.metricsUrl
            ? [
                  metricsJob({
                      url: configuration.metricsUrl,
                      token: configuration.metricsToken,
                  }),
              ]
            : []),
    ]);
    return { ...connection, registry };
}
export type OperationsRuntime = ReturnType<typeof createOperationsRuntime>;
