import type { OperationsConfiguration } from "../config/operations";
import { connectDashboardDatabase } from "../database/connection";
import type { ApplicationTarget } from "../integrations/applications/configuration";
import { applicationJobs } from "../integrations/applications/jobs";
import type { LogsConfiguration } from "../integrations/logs/transport";
import { collectInventory } from "../integrations/metrics/inventory";
import { metricsJob } from "../integrations/metrics/job";
import { createInventoryReader } from "../integrations/metrics/liveInventory";
import { readSavedInventory } from "../integrations/metrics/snapshot";
import type { MetricsConfiguration } from "../integrations/metrics/transport";
import { maintenanceJob } from "../jobs/maintenance";
import { createJobRegistry } from "../jobs/registry";

/**
 * Compose explicit operation modules for one dashboard or worker process.
 * @param configuration - Validated scoped deployment settings.
 * @returns Database ownership and executable inventory; the caller closes the pool.
 */
export function createOperationsRuntime(
    configuration: OperationsConfiguration
): OperationsRuntime {
    const connection = connectDashboardDatabase(configuration.databaseUrl);
    const registry = createJobRegistry([
        maintenanceJob(configuration.retentionDays),
        ...applicationJobs(configuration.applicationTargets ?? [], connection.client),
        ...(configuration.metricsUrl
            ? [
                  metricsJob(
                      {
                          url: configuration.metricsUrl,
                          token: configuration.metricsToken,
                      },
                      () => readSavedInventory(connection.client)
                  ),
              ]
            : []),
    ]);
    const metrics = configuration.metricsUrl
        ? { url: configuration.metricsUrl, token: configuration.metricsToken }
        : undefined;
    const readInventory = metrics
        ? createInventoryReader(async (previous) =>
              collectInventory(
                  metrics,
                  AbortSignal.timeout(10_000),
                  previous ?? (await readSavedInventory(connection.client))
              )
          )
        : undefined;
    return {
        ...connection,
        registry,
        metrics,
        readInventory,
        logs: configuration.logs,
        applicationTargets: configuration.applicationTargets ?? [],
    };
}
export type OperationsRuntime = ReturnType<typeof connectDashboardDatabase> & {
    readonly applicationTargets?: readonly ApplicationTarget[];
    readonly logs?: LogsConfiguration | undefined;
    readonly registry: ReturnType<typeof createJobRegistry>;
    readonly metrics?: MetricsConfiguration | undefined;
    readonly readInventory?: ReturnType<typeof createInventoryReader> | undefined;
};
