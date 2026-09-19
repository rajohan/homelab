import {
    parseApplicationTargets,
    type ApplicationTarget,
} from "../integrations/applications/configuration";
import type { LogsConfiguration } from "../integrations/logs/transport";

export interface OperationsConfiguration {
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
