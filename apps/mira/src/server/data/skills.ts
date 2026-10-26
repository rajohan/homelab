import type {
    MiraSkillSummary,
    miraSkillReadSchema,
} from "@homelab/contracts/miraSkills";
import type * as v from "valibot";

import { describeMiraSkillPackages, readBundledMiraSkill } from "../skills/catalog";
import { miraSkillsCompatibility } from "../skills/status";
import { listMiraSwitches } from "./automations";
import { MiraFailure, type MiraContext } from "./context";

/**
 * List installed guidance with only the current owner's independent pause controls.
 * @param context - Verified operator or leased run context.
 * @param repositoryOnly - Restrict automatic improvement context without widening tools.
 * @returns Bounded release metadata and owned controls, including intentional pauses.
 */
export async function listMiraSkills(
    context: MiraContext,
    repositoryOnly = false
): Promise<MiraSkillSummary[]> {
    const controls = await listMiraSwitches(context);
    const compatibility = await miraSkillsCompatibility(context.client);
    return describeMiraSkillPackages()
        .filter((skill) => !repositoryOnly || skill.repositoryContext)
        .map((skill) => ({
            ...skill,
            compatibility,
            control: controls.find((control) => control.key === `skill:${skill.id}`)!,
        }));
}

/**
 * Inspect bundled guidance for human review, including a currently paused package.
 * @param input - Validated package identifier and exact file key.
 * @returns Passive document bytes and their installed version/digest.
 */
export function inspectMiraSkill(input: v.InferOutput<typeof miraSkillReadSchema>) {
    const document = readBundledMiraSkill(input.id, input.file);
    if (!document) throw new MiraFailure("NOT_FOUND", "Skill file not found.");
    if (document.packageHash !== input.packageHash)
        throw new MiraFailure(
            "CONFLICT",
            "This skill changed. Refresh the catalog before loading it."
        );
    return document;
}

/**
 * Load guidance only after a fresh owner control and immutable run-scope check.
 * @param context - Current leased model invocation, never model-supplied ownership.
 * @param input - Validated package/file selection.
 * @param repositoryOnly - Restrict legacy or improvement automations to repository context.
 * @returns Installed guidance; loading never grants provider access or more tools.
 */
export async function loadMiraSkill(
    context: MiraContext,
    input: v.InferOutput<typeof miraSkillReadSchema>,
    repositoryOnly: boolean
) {
    const skill = describeMiraSkillPackages().find((entry) => entry.id === input.id);
    if (!skill || (repositoryOnly && !skill.repositoryContext))
        throw new MiraFailure(
            "FORBIDDEN",
            "This skill is outside the run's context scope."
        );
    const [control] = await context.client<{ enabled: boolean }[]>`
        SELECT enabled FROM mira_switches
        WHERE owner=${context.owner} AND key=${`skill:${input.id}`}`;
    if (!control?.enabled)
        throw new MiraFailure(
            "PRECONDITION_FAILED",
            "This skill is paused or not enabled."
        );
    return inspectMiraSkill(input);
}
