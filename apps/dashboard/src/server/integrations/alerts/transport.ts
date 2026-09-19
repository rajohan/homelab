import type { Incident } from "@homelab/contracts/alerts";
import * as v from "valibot";

import { readBoundedJson } from "../http/readJson";

const text = v.pipe(v.string(), v.maxLength(200));
const timestamp = v.pipe(v.string(), v.isoTimestamp());
const alertSchema = v.object({
    fingerprint: v.pipe(v.string(), v.regex(/^[a-f0-9]{16,64}$/)),
    labels: v.object({
        alertname: v.pipe(text, v.minLength(1)),
        severity: v.optional(text),
        host: v.optional(text),
        service: v.optional(text),
        component: v.optional(text),
    }),
    startsAt: timestamp,
    endsAt: timestamp,
    status: v.object({
        state: v.picklist(["unprocessed", "active", "suppressed"]),
    }),
});
export interface AlertsConfiguration {
    readonly url: string;
    readonly token: string | undefined;
    readonly excludedNames: readonly string[];
}
export interface ObservedAlert {
    readonly key: string;
    readonly name: string;
    readonly host: string | null;
    readonly service: string | null;
    readonly severity: Incident["severity"];
    readonly state: "active" | "suppressed";
    readonly startedAt: string;
}

function alertSeverity(value: string | undefined): Incident["severity"] {
    if (value === "critical" || value === "error") return "error";
    if (value === "warning" || value === "warn") return "warning";
    return "info";
}

/**
 * Read the complete bounded Alertmanager inventory, including suppressed alerts.
 * @param configuration - Trusted API base and read-only credential; never browser input.
 * @param signal - Caller cancellation and deadline.
 * @returns Safe incident metadata without annotations, receiver credentials or arbitrary labels.
 */
export async function readAlerts(
    configuration: AlertsConfiguration,
    signal: AbortSignal
): Promise<ObservedAlert[]> {
    const url = new URL(configuration.url.replace(/\/$/, "") + "/api/v2/alerts");
    url.search = new URLSearchParams({
        active: "true",
        silenced: "true",
        inhibited: "true",
        unprocessed: "true",
    }).toString();
    const response = await fetch(url, {
        signal,
        redirect: "error",
        headers: configuration.token
            ? { Authorization: `Bearer ${configuration.token}` }
            : {},
    });
    const data = v.parse(
        v.pipe(v.array(alertSchema), v.maxLength(1000)),
        await readBoundedJson(response)
    );
    const records = data
        .filter((alert) => !configuration.excludedNames.includes(alert.labels.alertname))
        .map((alert) => ({
            key: new Bun.CryptoHasher("sha256")
                .update(
                    JSON.stringify([configuration.url, alert.fingerprint, alert.startsAt])
                )
                .digest("hex"),
            name: alert.labels.alertname,
            host: alert.labels.host ?? null,
            service: alert.labels.service ?? alert.labels.component ?? null,
            severity: alertSeverity(alert.labels.severity),
            state:
                alert.status.state === "suppressed"
                    ? ("suppressed" as const)
                    : ("active" as const),
            startedAt: alert.startsAt,
        }));
    if (new Set(records.map((record) => record.key)).size !== records.length)
        throw new Error("Alertmanager returned duplicate incident identities");
    return records;
}
