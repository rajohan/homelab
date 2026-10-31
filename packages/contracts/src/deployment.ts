import * as v from "valibot";

import { disableReasonSchema } from "./schedules";

const target = v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{0,49}$/));
const version = v.pipe(v.number(), v.integer(), v.minValue(0));
export const deploymentWindowSchema = v.strictObject({
    start: v.pipe(v.string(), v.regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/)),
    minutes: v.pipe(v.number(), v.integer(), v.minValue(15), v.maxValue(240)),
});
export const deploymentPolicySchema = v.strictObject({
    target,
    version,
    mode: v.picklist(["manual", "patch", "minor"]),
    window: deploymentWindowSchema,
});
export const deploymentPauseSchema = v.pipe(
    v.strictObject({
        target,
        version,
        paused: v.boolean(),
        reason: v.nullable(disableReasonSchema),
        until: v.nullable(v.pipe(v.number(), v.integer(), v.minValue(1))),
    }),
    v.check((value) =>
        value.paused
            ? value.reason !== null
            : value.reason === null && value.until === null
    )
);
export type DeploymentPolicyInput = v.InferOutput<typeof deploymentPolicySchema>;
export interface DeploymentPolicySummary {
    target: string;
    version: number;
    mode: "manual" | "patch" | "minor";
    window: v.InferOutput<typeof deploymentWindowSchema>;
    paused: boolean;
    reason: string | null;
    until: number | null;
    configurationChanged: boolean;
    timeZone: string;
}
