import type { MonitoringRule, RuleInventory } from "@homelab/contracts/alerts";
import * as v from "valibot";

import { readBoundedJson } from "../http/readJson";

export interface RulesConfiguration {
    readonly url: string;
    readonly token: string | undefined;
}
const text = v.pipe(v.string(), v.maxLength(200));
const nonnegative = v.pipe(v.number(), v.finite(), v.minValue(0));
const ruleSchema = v.object({
    name: text,
    type: v.picklist(["alerting", "recording"]),
    state: v.optional(v.string()),
    health: v.optional(v.string()),
    lastEvaluation: v.optional(v.string()),
    duration: v.optional(nonnegative, 0),
});
const groupSchema = v.object({
    name: text,
    interval: v.pipe(nonnegative, v.minValue(1)),
    rules: v.pipe(v.array(ruleSchema), v.maxLength(2000)),
});
const schema = v.object({
    status: v.literal("success"),
    data: v.object({ groups: v.pipe(v.array(groupSchema), v.maxLength(200)) }),
});

/**
 * Read all loaded alerting rules, including inactive and heartbeat rules, without private expressions.
 * @param configuration - Trusted vmalert/Prometheus-compatible rule API settings.
 * @param signal - Job deadline and cancellation.
 * @returns Safe rule state and evaluator health; no annotations, queries or raw errors.
 */
export async function readRules(
    configuration: RulesConfiguration,
    signal: AbortSignal
): Promise<RuleInventory> {
    const response = await fetch(configuration.url.replace(/\/$/, "") + "/api/v1/rules", {
        signal,
        redirect: "error",
        headers: configuration.token
            ? { Authorization: `Bearer ${configuration.token}` }
            : {},
    });
    const data = v.parse(schema, await readBoundedJson(response));
    const rules: MonitoringRule[] = [];
    for (const group of data.data.groups) {
        for (const rule of group.rules) {
            if (rule.type !== "alerting") continue;
            const at = Date.parse(rule.lastEvaluation ?? "");
            const recent =
                Number.isFinite(at) &&
                at > 0 &&
                at <= Date.now() + 60_000 &&
                Date.now() - at < Math.max(180, group.interval * 3) * 1000;
            let health: MonitoringRule["health"] = "unknown";
            if (recent && rule.health === "ok") health = "healthy";
            else if (recent && ["err", "error"].includes(rule.health ?? ""))
                health = "error";
            let state: MonitoringRule["state"] = "unknown";
            if (recent && ["inactive", "pending", "firing"].includes(rule.state ?? ""))
                state = rule.state as "inactive" | "pending" | "firing";
            rules.push({
                id: new Bun.CryptoHasher("sha256")
                    .update(JSON.stringify([configuration.url, group.name, rule.name]))
                    .digest("hex"),
                name: rule.name,
                group: group.name,
                state,
                health,
                lastEvaluationAt:
                    Number.isFinite(at) && at > 0 && at <= Date.now() + 60_000
                        ? new Date(at).toISOString()
                        : null,
                intervalSeconds: group.interval,
                durationSeconds: rule.duration,
            });
        }
    }
    if (
        rules.length > 2000 ||
        new Set(rules.map((rule) => rule.id)).size !== rules.length
    )
        throw new Error("Invalid monitoring rule inventory");
    return {
        capturedAt: new Date().toISOString(),
        rules: rules.toSorted(
            (a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name)
        ),
    };
}
