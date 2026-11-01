import { miraCodeInputSchema } from "@homelab/contracts/miraCode";
import { miraImprovementPolicy } from "@homelab/contracts/miraImprovement";
import * as v from "valibot";

import { parseSandboxEditPlan } from "../sandbox/edits";

export const improvementInputSchema = v.strictObject({
    commit: miraCodeInputSchema.entries.commit,
    title: miraCodeInputSchema.entries.title,
    body: miraCodeInputSchema.entries.body,
    plan: v.unknown(),
});
/**
 * Validate bounded repository edits against the fixed operator-reviewed policy.
 * @param input - Exact main, proposed PR text and complete structured edit document.
 * @returns Canonical text and plan; no file, network or code execution occurs here.
 */
export function parseImprovement(input: unknown) {
    const parsed = v.parse(improvementInputSchema, input),
        text = JSON.stringify(parsed.plan);
    if (Buffer.byteLength(text) > miraImprovementPolicy.maximumPlanBytes)
        throw new Error("The edit plan exceeds 256 KiB.");
    const plan = parseSandboxEditPlan(Buffer.from(text), parsed.commit);
    if (plan.files.length > miraImprovementPolicy.maximumFiles)
        throw new Error("Choose at most ten repository files.");
    for (const file of plan.files) {
        if (file.beforeSha256 === null && file.content === null)
            throw new Error("A missing file cannot be deleted.");
        if (
            file.content !== null &&
            Buffer.byteLength(file.content) > miraImprovementPolicy.maximumFileBytes
        )
            throw new Error("Each replacement must fit within 64 KiB.");
    }
    return { ...parsed, plan, text: JSON.stringify(plan) };
}
