import type { UpdateReport } from "@homelab/contracts/updates";
import type { SQL } from "bun";

import { readRules } from "../integrations/alerts/rules";
import { synchronizeAlerts } from "../integrations/alerts/synchronize";
import { readAlerts } from "../integrations/alerts/transport";
import { readBackupCatalog } from "../integrations/backups/catalog";

export const previewUpdateSources = [
    {
        id: "demo-main",
        label: "Demo Main",
        publisher: "11111111-1111-4111-8111-111111111111",
    },
    {
        id: "demo-sentinel",
        label: "Demo Sentinel",
        publisher: "22222222-2222-4222-8222-222222222222",
    },
];

/**
 * Serve synthetic monitoring only on loopback; no production alert or backup is changed.
 * @returns A bounded fixture endpoint and a mandatory disposal callback.
 */
export function createMonitoringFixture() {
    const startedAt = new Date().toISOString();
    const alerts = [
        {
            fingerprint: "1111111111111111",
            labels: {
                alertname: "DemoApplicationUnhealthy",
                host: "demo-main",
                service: "health-failure",
                severity: "warning",
            },
            startsAt: startedAt,
            endsAt: "2099-01-01T00:00:00Z",
            status: { state: "active" },
        },
        {
            fingerprint: "2222222222222222",
            labels: {
                alertname: "DemoMaintenance",
                host: "demo-sentinel",
                service: "node",
                severity: "info",
            },
            startsAt: startedAt,
            endsAt: "2099-01-01T00:00:00Z",
            status: { state: "suppressed" },
        },
    ];
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: (request) => {
            const path = new URL(request.url).pathname;
            if (path === "/api/v2/alerts") return Response.json(alerts);
            if (path === "/api/v1/rules")
                return Response.json({
                    status: "success",
                    data: {
                        groups: [
                            {
                                name: "demo-host-health",
                                interval: 30,
                                rules: Array.from({ length: 45 }, (_, index) => ({
                                    name:
                                        [
                                            "DemoApplicationUnhealthy",
                                            "DemoBackupAge",
                                            "DemoHostMemory",
                                            "DemoQueryUnavailable",
                                        ][index] ?? `DemoServiceCheck${index + 1}`,
                                    type: "alerting",
                                    health: index === 3 ? "err" : "ok",
                                    state:
                                        ["firing", "pending", "inactive"][index] ??
                                        "inactive",
                                    lastEvaluation: new Date().toISOString(),
                                    duration: 120,
                                })),
                            },
                        ],
                    },
                });
            if (path === "/api2/json/admin/datastore/demo-backups/snapshots")
                return Response.json({
                    data: Array.from({ length: 65 }, (_, index) => ({
                        "backup-type": "vm",
                        "backup-id": index < 45 ? "demo-main" : "demo-monitor",
                        "backup-time":
                            Math.floor(Date.now() / 86_400_000) * 86_400 - index * 86_400,
                        size: (index < 45 ? 32 : 16) * 1024 ** 3 + 1024 ** 2 * index,
                        protected: index === 0,
                        verification:
                            index === 2 ? null : { state: index === 4 ? "failed" : "ok" },
                    })),
                });
            if (path === "/api/v1/query") {
                const now = Date.now() / 1000;
                const tasks = [
                    "pbs-vm-demo",
                    "pbs-verification-demo",
                    "postgres-logical-demo",
                ];
                const rows: {
                    metric: Record<string, string>;
                    value: [number, string];
                }[] = [
                    {
                        metric: { __name__: "up", job: "node", host: "demo-backup" },
                        value: [now, "1"],
                    },
                ];
                for (const [index, task] of tasks.entries()) {
                    const values = {
                        history_known: 1,
                        last_completed_success: index === 2 ? 0 : 1,
                        current_failed: index === 2 ? 1 : 0,
                        current_running: 0,
                        timer_active: 1,
                        timer_enabled: 1,
                        max_age_seconds: 86_400,
                        last_success_timestamp_seconds: now - 3600,
                        last_failure_timestamp_seconds: index === 2 ? now - 300 : 0,
                    };
                    for (const [name, value] of Object.entries(values))
                        rows.push({
                            metric: {
                                __name__: `homelab_backup_${name}`,
                                job: "node",
                                host: "demo-backup",
                                task,
                            },
                            value: [now, String(value)],
                        });
                }
                return Response.json({
                    status: "success",
                    data: { resultType: "vector", result: rows },
                });
            }
            return new Response("Not found", { status: 404 });
        },
    });
    return { url: server.url.origin, close: () => server.stop(true) };
}

/**
 * Seed disposable incidents and package data for visual acceptance without real host control.
 * @param client - Newly created preview database only.
 * @param url - Loopback fixture URL.
 * @returns Completion after isolated sample data is committed.
 */
export async function seedMonitoringPreview(client: SQL, url: string): Promise<void> {
    const rules = await readRules({ url, token: undefined }, AbortSignal.timeout(5000));
    const catalog = await readBackupCatalog(
        {
            url,
            token: "demo@pbs!reader:synthetic-only",
            stores: [{ datastore: "demo-backups", namespace: "" }],
        },
        AbortSignal.timeout(5000)
    );
    const alerts = await readAlerts(
        { url, token: undefined, excludedNames: [] },
        AbortSignal.timeout(5000)
    );
    await client.begin(async (transaction) => {
        for (const [key, inventory] of [
            ["monitoring.rules", rules],
            ["backups.catalog", catalog],
        ] as const)
            await transaction`INSERT INTO operation_snapshots (key, value, captured_at) VALUES (${key}, ${JSON.stringify(inventory)}::text::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, captured_at = EXCLUDED.captured_at`;
        await synchronizeAlerts(transaction, [
            {
                key: "3".repeat(64),
                name: "DemoBackupRecovered",
                host: "demo-backup",
                service: "backup",
                severity: "warning",
                state: "active",
                startedAt: new Date(Date.now() - 600_000).toISOString(),
            },
        ]);
        await synchronizeAlerts(transaction, alerts);
        for (const source of previewUpdateSources) {
            const report: UpdateReport = {
                capturedAt: new Date().toISOString(),
                repositoryMetadataAt: new Date().toISOString(),
                complete: true,
                coveredKinds: ["os", "runtime", "container"],
                items: [
                    {
                        id: "apt:openssl",
                        name: "openssl",
                        kind: "os",
                        installed: "3.5.0-1",
                        available: "3.5.1-1",
                        status: "available",
                        security: true,
                        held: false,
                    },
                    {
                        id: "runtime:bun",
                        name: "Bun",
                        kind: "runtime",
                        installed: "1.4.2",
                        available: "1.4.2",
                        status: "current",
                        security: false,
                        held: false,
                    },
                    {
                        id: "docker:private",
                        name: "Private application",
                        kind: "container",
                        installed: "sha256:" + "a".repeat(64),
                        available: null,
                        status: "unknown",
                        security: false,
                        held: true,
                    },
                    ...Array.from({ length: 120 }, (_, index) => ({
                        id: `apt:demo-${String(index).padStart(3, "0")}`,
                        name: `Demo package ${index + 1}`,
                        kind: "os" as const,
                        installed: "1.0-1",
                        available: "1.1-1",
                        status: "available" as const,
                        security: false,
                        held: index % 10 === 0,
                    })),
                ],
            };
            await transaction`INSERT INTO operation_snapshots (key, value, captured_at) VALUES (${`updates:${source.id}`}, ${JSON.stringify(report)}::text::jsonb, now())`;
        }
    });
}
