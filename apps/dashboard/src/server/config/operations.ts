import type { UpdateSource } from "@homelab/contracts/updates";
import * as v from "valibot";

import type { RulesConfiguration } from "../integrations/alerts/rules";
import type { AlertsConfiguration } from "../integrations/alerts/transport";
import {
    parseApplicationTargets,
    type ApplicationTarget,
} from "../integrations/applications/configuration";
import type { BackupCatalogConfiguration } from "../integrations/backups/catalog";
import type { LogsConfiguration } from "../integrations/logs/transport";

const storeSchema = v.strictObject({
    datastore: v.pipe(v.string(), v.regex(/^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,99}$/)),
    namespace: v.optional(
        v.pipe(
            v.string(),
            v.maxLength(256),
            v.regex(
                /^(?:[a-zA-Z0-9_][a-zA-Z0-9_.-]*(?:\/[a-zA-Z0-9_][a-zA-Z0-9_.-]*)*)?$/
            )
        ),
        ""
    ),
});

export interface OperationsConfiguration {
    readonly rules?: RulesConfiguration | undefined;
    readonly backupCatalog?: BackupCatalogConfiguration | undefined;
    readonly updateSources?: readonly UpdateSource[];
    readonly alerts?: AlertsConfiguration | undefined;
    readonly applicationTargets?: readonly ApplicationTarget[];
    readonly logs?: LogsConfiguration | undefined;
    readonly databaseUrl: string;
    readonly metricsUrl: string | undefined;
    readonly metricsToken: string | undefined;
    readonly concurrency: number;
    readonly retentionDays: number;
}

/**
 * Parse optional dashboard operations configuration without embedding deployment addresses.
 * @param environment - Scoped process environment values.
 * @returns Validated settings, or undefined when operations have not been provisioned.
 */
export function parseOperationsConfiguration(
    environment: Readonly<Record<string, string | undefined>>
): OperationsConfiguration | undefined {
    const databaseUrl = environment.HOMELAB_DASHBOARD_DATABASE_URL;
    if (!databaseUrl) return;
    const database = new URL(databaseUrl);
    if (
        !["postgres:", "postgresql:"].includes(database.protocol) ||
        !database.pathname ||
        database.pathname === "/"
    )
        throw new Error("A dashboard PostgreSQL database is required");
    const metricsUrl = environment.HOMELAB_DASHBOARD_METRICS_URL;
    const logsUrl = environment.HOMELAB_DASHBOARD_LOGS_URL;
    const alertsUrl = environment.HOMELAB_DASHBOARD_ALERTMANAGER_URL;
    const rulesUrl = environment.HOMELAB_DASHBOARD_RULES_URL;
    const pbsUrl = environment.HOMELAB_DASHBOARD_PBS_URL;
    for (const address of [rulesUrl, pbsUrl]) {
        if (!address) continue;
        const target = new URL(address);
        if (
            !["http:", "https:"].includes(target.protocol) ||
            target.username ||
            target.password ||
            target.search ||
            target.hash
        )
            throw new Error("Monitoring URL must be a credential-free HTTP(S) base URL");
        if (
            address === pbsUrl &&
            target.protocol !== "https:" &&
            !(
                ["test", "development"].includes(environment.NODE_ENV ?? "") &&
                target.hostname === "127.0.0.1"
            )
        )
            throw new Error("Backup catalog requires HTTPS");
    }
    const pbsToken = environment.HOMELAB_DASHBOARD_PBS_TOKEN;
    if (pbsUrl && (!pbsToken || !/^[^\s=]+@[^\s=!]+![^\s=]+=[^\s]+$/.test(pbsToken)))
        throw new Error("Backup catalog requires a PBS audit token");
    const stores = v.parse(
        v.pipe(v.array(storeSchema), v.maxLength(20)),
        JSON.parse(environment.HOMELAB_DASHBOARD_PBS_STORES ?? "[]") as unknown
    );
    if (
        new Set(stores.map((store) => JSON.stringify(store))).size !== stores.length ||
        (pbsUrl && stores.length === 0)
    )
        throw new Error(
            "Backup catalog requires distinct explicit datastores/namespaces"
        );
    if (alertsUrl) {
        const target = new URL(alertsUrl);
        if (
            !["http:", "https:"].includes(target.protocol) ||
            target.username ||
            target.password ||
            target.search ||
            target.hash
        )
            throw new Error(
                "Alertmanager URL must be a credential-free HTTP(S) base URL"
            );
    }
    const excludedNames = v.parse(
        v.pipe(
            v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
            v.maxLength(100)
        ),
        JSON.parse(
            environment.HOMELAB_DASHBOARD_ALERT_EXCLUDED_NAMES ?? '["Watchdog"]'
        ) as unknown
    );
    const updateSources = v.parse(
        v.pipe(
            v.array(
                v.strictObject({
                    id: v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{0,63}$/)),
                    label: v.pipe(v.string(), v.minLength(1), v.maxLength(100)),
                    publisher: v.pipe(v.string(), v.uuid()),
                })
            ),
            v.maxLength(100)
        ),
        JSON.parse(environment.HOMELAB_DASHBOARD_UPDATE_SOURCES ?? "[]") as unknown
    );
    if (
        new Set(updateSources.map((source) => source.id)).size !== updateSources.length ||
        new Set(updateSources.map((source) => source.publisher)).size !==
            updateSources.length
    )
        throw new Error("Update sources and publisher accounts must be unique");
    if (logsUrl) {
        const target = new URL(logsUrl);
        if (
            !["http:", "https:"].includes(target.protocol) ||
            target.username ||
            target.password ||
            target.search ||
            target.hash
        )
            throw new Error("Logs URL must be a credential-free HTTP(S) base URL");
    }
    if (metricsUrl) {
        const target = new URL(metricsUrl);
        if (
            !["http:", "https:"].includes(target.protocol) ||
            target.username ||
            target.password ||
            target.search ||
            target.hash
        )
            throw new Error("Metrics URL must be a credential-free HTTP(S) base URL");
    }
    const concurrency = Number(environment.HOMELAB_DASHBOARD_WORKER_CONCURRENCY ?? 3);
    const retentionDays = Number(environment.HOMELAB_DASHBOARD_JOB_RETENTION_DAYS ?? 30);
    if (
        !Number.isInteger(concurrency) ||
        concurrency < 1 ||
        concurrency > 16 ||
        !Number.isInteger(retentionDays) ||
        retentionDays < 1 ||
        retentionDays > 365
    )
        throw new Error("Invalid worker concurrency or retention policy");
    return {
        rules: rulesUrl
            ? { url: rulesUrl, token: environment.HOMELAB_DASHBOARD_RULES_TOKEN }
            : undefined,
        backupCatalog:
            pbsUrl && pbsToken ? { url: pbsUrl, token: pbsToken, stores } : undefined,
        updateSources,
        alerts: alertsUrl
            ? {
                  url: alertsUrl,
                  token: environment.HOMELAB_DASHBOARD_ALERTMANAGER_TOKEN,
                  excludedNames,
              }
            : undefined,
        logs: logsUrl
            ? { url: logsUrl, token: environment.HOMELAB_DASHBOARD_LOGS_TOKEN }
            : undefined,
        applicationTargets: parseApplicationTargets(
            environment.HOMELAB_DASHBOARD_APPLICATION_TARGETS,
            ["test", "development"].includes(environment.NODE_ENV ?? "")
        ),
        databaseUrl,
        metricsUrl,
        metricsToken: environment.HOMELAB_DASHBOARD_METRICS_TOKEN,
        concurrency,
        retentionDays,
    };
}
