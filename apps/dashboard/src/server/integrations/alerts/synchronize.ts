import type { Transaction } from "../../database/connection";
import { publishNotification } from "../../notifications/publish";
import type { ObservedAlert } from "./transport";

/**
 * Reconcile a complete successful source inventory and publish immutable transition events.
 * @param transaction - The worker's fenced snapshot transaction.
 * @param alerts - Validated complete inventory, never a partial or failed response.
 * @returns Completion after state, notification events and source freshness commit together.
 */
export async function synchronizeAlerts(
    transaction: Transaction,
    alerts: readonly ObservedAlert[]
): Promise<void> {
    const current = await transaction<
        {
            id: string;
            sourceKey: string;
            name: string;
            host: string | null;
            state: string;
        }[]
    >`SELECT id, source_key AS "sourceKey", name, host, state FROM operational_incidents WHERE state != 'resolved' FOR UPDATE`;
    for (const alert of alerts) {
        const [inserted] = await transaction<
            { id: string }[]
        >`INSERT INTO operational_incidents (id, source_key, name, host, service, severity, state, started_at) VALUES (${Bun.randomUUIDv7()}, ${alert.key}, ${alert.name}, ${alert.host}, ${alert.service}, ${alert.severity}, ${alert.state}, ${new Date(alert.startedAt)}) ON CONFLICT (source_key) DO NOTHING RETURNING id`;
        if (inserted)
            await publishNotification(transaction, "alerts", {
                key: `${alert.key}:opened`,
                title: alert.name.slice(0, 160),
                message: `Monitoring reported ${alert.name}${alert.host ? ` on ${alert.host}` : ""}.`,
                severity: alert.severity,
                destination: "alerts",
            });
        await transaction`UPDATE operational_incidents SET state = ${alert.state}, resolved_at = NULL, observed_at = now() WHERE source_key = ${alert.key}`;
    }
    const keys = new Set(alerts.map((alert) => alert.key));
    for (const incident of current) {
        if (keys.has(incident.sourceKey)) continue;
        await transaction`UPDATE operational_incidents SET state = 'resolved', resolved_at = now(), observed_at = now() WHERE id = ${incident.id}`;
        await publishNotification(transaction, "alerts", {
            key: `${incident.sourceKey}:resolved`,
            title: `Resolved: ${incident.name}`.slice(0, 160),
            message: `Monitoring no longer reports ${incident.name}${incident.host ? ` on ${incident.host}` : ""} as active.`,
            severity: "success",
            destination: "alerts",
        });
    }
    await transaction`INSERT INTO operation_snapshots (key, value, captured_at) VALUES ('alerts', '{}'::jsonb, now()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, captured_at = EXCLUDED.captured_at`;
}
