import * as v from "valibot";

export const incidentStates = ["active", "suppressed", "resolved"] as const;
export const incidentStateSchema = v.picklist(incidentStates);
export const incidentPageSchema = v.strictObject({
    state: v.optional(v.picklist(["current", "resolved"]), "current"),
    before: v.optional(v.pipe(v.string(), v.uuid())),
    limit: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
        30
    ),
});
export interface Incident {
    readonly id: string;
    readonly name: string;
    readonly host: string | null;
    readonly service: string | null;
    readonly severity: "info" | "warning" | "error";
    readonly state: v.InferOutput<typeof incidentStateSchema>;
    readonly startedAt: string;
    readonly resolvedAt: string | null;
}
export interface MonitoringRule {
    readonly id: string;
    readonly name: string;
    readonly group: string;
    readonly state: "inactive" | "pending" | "firing" | "unknown";
    readonly health: "healthy" | "error" | "unknown";
    readonly lastEvaluationAt: string | null;
    readonly intervalSeconds: number;
    readonly durationSeconds: number;
}
export interface RuleInventory {
    readonly capturedAt: string;
    readonly rules: readonly MonitoringRule[];
}
