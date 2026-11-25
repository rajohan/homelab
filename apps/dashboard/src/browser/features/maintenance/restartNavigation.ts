import type { api } from "../../api/client";

export type RestartPlan = Awaited<ReturnType<typeof api.maintenance.plans.query>>[number];
export type RequirementFilter =
    | "attention"
    | "all"
    | "required"
    | "unknown"
    | "not-required";
export type RestartLocationFilter = "all" | "dashboard" | "external";
export interface RestartGroup {
    readonly host: RestartPlan["host"];
    readonly plans: readonly RestartPlan[];
    readonly required: number;
}

/** Check whether a host-wide service report or a specific requirement is incomplete.
 * @param plan - Latest target reading returned by the server.
 * @returns Whether the operator cannot see all restart requirements for this target.
 */
export function incompleteRestart(plan: RestartPlan): boolean {
    return (
        (plan.kind === "host" && plan.fleetEvidence !== "measured") ||
        (plan.required === null && plan.active !== "inactive")
    );
}

/** Describe pending fleet work independently of the operator's current list filters.
 * @param plans - Current plans from the configured hosts and their service reports.
 * @returns Eligible services, outstanding manual items and whole-host reboots.
 */
export function restartWorkload(plans: readonly RestartPlan[]) {
    const required = plans.filter((plan) => plan.required === true);
    const services = required.filter((plan) => plan.kind === "service");
    return {
        eligible: services.filter((plan) => plan.allowed && !plan.external),
        manual: services.filter((plan) => plan.external),
        unavailable: services.filter((plan) => !plan.external && !plan.allowed),
        reboots: required.filter((plan) => plan.kind === "host"),
        incompleteHosts: new Set(
            plans.filter((plan) => incompleteRestart(plan)).map((plan) => plan.host.id)
        ).size,
    };
}

/** Group visible restart targets by host, preserving host actions and prioritising outstanding work.
 * @param plans - Fleet observations.
 * @param search - Case-insensitive terms matched against host, service label and unit name.
 * @param requirement - Current requirement filter.
 * @param location - Current restart location filter.
 * @returns Host groups with pending work first and host actions separated from service actions.
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
        const text = [plan.host.label, plan.label, plan.unit].join(" ").toLowerCase();
        const unknown = incompleteRestart(plan);
        if (
            !words.every((word) => text.includes(word)) ||
            (requirement === "attention" && !plan.required && !unknown) ||
            (requirement === "required" && plan.required !== true) ||
            (requirement === "unknown" && !unknown) ||
            (requirement === "not-required" && (plan.required !== false || unknown)) ||
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
        if (plan.required) group.required++;
        groups.set(plan.host.id, group);
    }
    return [...groups.values()]
        .map((group) => ({
            ...group,
            plans: group.plans.toSorted(
                (a, b) =>
                    Number(b.kind === "host") - Number(a.kind === "host") ||
                    Number(b.required === true) - Number(a.required === true) ||
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
