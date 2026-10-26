import * as v from "valibot";

import { idSchema } from "./operations";

export const miraImprovementPolicy = Object.freeze({
    version: 1,
    paths: ["apps/dashboard/src/browser/", "packages/ui/src/components/"],
    maximumFiles: 10,
    maximumFileBytes: 65_536,
    maximumPlanBytes: 262_144,
    attemptsPerDay: 2,
    minutesPerCheck: 10,
});
export const miraImprovementGrantSchema = v.strictObject({
    automationId: idSchema,
    automationVersion: v.pipe(v.number(), v.integer(), v.minValue(1)),
    version: v.pipe(v.number(), v.integer(), v.minValue(0)),
    enabled: v.boolean(),
    policyVersion: v.literal(1),
});
export interface MiraImprovementGrant {
    automationId: string;
    version: number;
    enabled: boolean;
    current: boolean;
    available: boolean;
    blocked: { id: string; canClose: boolean; reason: string } | null;
}

export const miraImprovementResolveSchema = v.strictObject({
    id: idSchema,
    reviewed: v.literal(true),
    reason: v.pipe(v.string(), v.trim(), v.minLength(10), v.maxLength(2000)),
});
