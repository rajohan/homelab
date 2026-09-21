import type { UpdateSource } from "@homelab/contracts/updates";

import type { OperationsConfiguration } from "../config/operations";
import { connectDashboardDatabase } from "../database/connection";
import { alertsJob } from "../integrations/alerts/job";
import { readRules, type RulesConfiguration } from "../integrations/alerts/rules";
import type { AlertsConfiguration } from "../integrations/alerts/transport";
import type { ApplicationTarget } from "../integrations/applications/configuration";
import { applicationJobs } from "../integrations/applications/jobs";
import {
    readBackupCatalog,
    type BackupCatalogConfiguration,
} from "../integrations/backups/catalog";
import { backupsJob } from "../integrations/backups/job";
import { readBackupInventory } from "../integrations/backups/routes";
import type { LogsConfiguration } from "../integrations/logs/transport";
import { collectInventory } from "../integrations/metrics/inventory";
import { metricsJob } from "../integrations/metrics/job";
import { createInventoryReader } from "../integrations/metrics/liveInventory";
import { readSavedInventory } from "../integrations/metrics/snapshot";
import type { MetricsConfiguration } from "../integrations/metrics/transport";
import { snapshotJob } from "../integrations/snapshots/job";
import { updateActionJobs } from "../integrations/updates/actions";
import type { UpdateTarget } from "../integrations/updates/configuration";
import { updatesJob } from "../integrations/updates/job";
import { restartStatusJob } from "../integrations/updates/restart";
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
        ...updateActionJobs(
            configuration.updateTargets ?? [],
            connection.client,
            undefined,
            configuration.applicationTargets ?? []
        ),
        ...(configuration.updateTargets?.length
            ? [restartStatusJob(configuration.updateTargets)]
            : []),
        ...(configuration.rules
            ? [
                  snapshotJob({
                      key: "monitoring.rules",
                      label: "Refresh monitoring rules",
                      description: "Read rule states and evaluation health.",
                      capability: "alerts:refresh",
                      intervalSeconds: 60,
                      read: (signal) => readRules(configuration.rules!, signal),
                  }),
              ]
            : []),
        ...(configuration.backupCatalog
            ? [
                  snapshotJob({
                      key: "backups.catalog",
                      label: "Refresh backup snapshots",
                      description:
                          "Read snapshot sizes, protection and verification metadata.",
                      capability: "backups:refresh",
                      intervalSeconds: 300,
                      read: (signal) =>
                          readBackupCatalog(configuration.backupCatalog!, signal),
                  }),
              ]
            : []),
        maintenanceJob(configuration.retentionDays),
        ...(configuration.updateSources?.length
            ? [updatesJob(configuration.updateSources, connection.client)]
            : []),
        ...(configuration.alerts ? [alertsJob(configuration.alerts)] : []),
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
                  backupsJob(
                      {
                          url: configuration.metricsUrl,
                          token: configuration.metricsToken,
                      },
                      () => readBackupInventory(connection.client)
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
        updateTargets: configuration.updateTargets ?? [],
        rules: configuration.rules,
        backupCatalog: configuration.backupCatalog,
        ...connection,
        registry,
        updateSources: configuration.updateSources ?? [],
        alerts: configuration.alerts,
        metrics,
        readInventory,
        logs: configuration.logs,
        applicationTargets: configuration.applicationTargets ?? [],
    };
}
export type OperationsRuntime = ReturnType<typeof connectDashboardDatabase> & {
    readonly updateTargets?: readonly UpdateTarget[];
    readonly rules?: RulesConfiguration | undefined;
    readonly backupCatalog?: BackupCatalogConfiguration | undefined;
    readonly updateSources?: readonly UpdateSource[];
    readonly alerts?: AlertsConfiguration | undefined;
    readonly applicationTargets?: readonly ApplicationTarget[];
    readonly logs?: LogsConfiguration | undefined;
    readonly registry: ReturnType<typeof createJobRegistry>;
    readonly metrics?: MetricsConfiguration | undefined;
    readonly readInventory?: ReturnType<typeof createInventoryReader> | undefined;
};
