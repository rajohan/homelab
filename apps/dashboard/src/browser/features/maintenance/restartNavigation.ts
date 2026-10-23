import type { api } from "../../api/client";

export type RestartPlan = Awaited<ReturnType<typeof api.maintenance.plans.query>>[number];
export type RequirementFilter = "all" | "required" | "unknown" | "not-required";
export type RestartLocationFilter = "all" | "dashboard" | "external";
export interface RestartGroup {
    readonly host: RestartPlan["host"];
    readonly plans: readonly RestartPlan[];
    readonly required: number;
}

/**
 * Resolve the requirement shown by badges and filters from the same usable evidence.
 * @param plan - Current public restart observation and availability.
 * @returns Known restart need, or null when this plan cannot establish it.
 */
export function restartRequirement(plan: RestartPlan): boolean | null {
    return plan.allowed || plan.external ? plan.required : null;
}

/**
 * Search and filter restart targets, keeping each host together with required work first.
 * @param plans - Current safe server plans; never mutated by navigation.
 * @param search - Case-insensitive literal words matched against host and target labels.
 * @param requirement - Requirement filter, consistent with each target's badge.
 * @param location - Whether the restart happens here or through an external operator.
 * @returns Required hosts first, then alphabetical hosts; required targets lead each group.
 */
export function restartGroups(
    plans: readonly RestartPlan[],
    search: string,
    requirement: RequirementFilter,
    location: RestartLocationFilter
): RestartGroup[] {
    const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const groups = new Map<
        string,
        { host: RestartPlan["host"]; plans: RestartPlan[]; required: number }
    >();
    for (const plan of plans) {
        const required = restartRequirement(plan);
        const text = `${plan.host.label} ${plan.label}`.toLowerCase();
        if (
            !words.every((word) => text.includes(word)) ||
            (requirement === "required" && required !== true) ||
            (requirement === "unknown" && required !== null) ||
            (requirement === "not-required" && required !== false) ||
            (location === "external" && !plan.external) ||
            (location === "dashboard" && plan.external)
        )
            continue;
        const group = groups.get(plan.host.id) ?? {
            host: plan.host,
            plans: [],
            required: 0,
        };
        group.plans.push(plan);
        if (required) group.required += 1;
        groups.set(plan.host.id, group);
    }
    return [...groups.values()]
        .map((group) => ({
            ...group,
            plans: group.plans.toSorted(
                (a, b) =>
                    Number(restartRequirement(b) === true) -
                        Number(restartRequirement(a) === true) ||
                    a.label.localeCompare(b.label) ||
                    a.target.localeCompare(b.target)
            ),
        }))
        .toSorted(
            (a, b) =>
                Number(b.required > 0) - Number(a.required > 0) ||
                a.host.label.localeCompare(b.host.label) ||
                a.host.id.localeCompare(b.host.id)
        );
}
