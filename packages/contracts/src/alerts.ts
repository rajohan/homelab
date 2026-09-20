import * as v from "valibot";

export const incidentStates = ["active", "suppressed", "resolved"] as const;
export const incidentStateSchema = v.picklist(incidentStates);
const incidentCursorSchema = v.strictObject({
    id: v.pipe(v.string(), v.uuid()),
    resolvedAt: v.optional(v.pipe(v.string(), v.isoTimestamp())),
});
export type IncidentCursor = v.InferOutput<typeof incidentCursorSchema>;
export const incidentPageSchema = v.pipe(
    v.strictObject({
        state: v.optional(v.picklist(["current", "resolved"]), "current"),
        before: v.optional(incidentCursorSchema),
        limit: v.optional(
            v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
            30
        ),
    }),
    v.check(
        (input) =>
            !input.before ||
            (input.state === "resolved"
                ? Boolean(input.before.resolvedAt)
                : input.before.resolvedAt === undefined),
        "Incident cursor must match the selected history"
    )
);
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
