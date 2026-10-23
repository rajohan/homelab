import { expect, test } from "bun:test";

import { restartGroups, type RestartPlan } from "./restartNavigation";

function plan(
    target: string,
    host: string,
    required: boolean | null,
    extra: Partial<RestartPlan> = {}
): RestartPlan {
    return {
        target,
        label: target,
        host: { id: host, label: host },
        required,
        impact: "Temporary interruption.",
        kind: "service",
        revision: "a".repeat(64),
        capturedAt: null,
        active: "active",
        allowed: true,
        external: false,
        reason: null,
        ...extra,
    };
}
const plans = [
    plan("Agent", "Alpha", false),
    plan("Zoo", "Zulu", true),
    plan("Agent", "Zulu", false),
    plan("Web", "Beta", true, { external: true, allowed: false }),
    plan("Stopped", "Alpha", true, { allowed: false }),
    plan("Unknown", "Beta", null),
];

test("required hosts and targets lead stable groups without mutating the response", () => {
    const before = structuredClone(plans);
    const groups = restartGroups(plans, "", "all", "all");
    expect(groups.map((group) => group.host.label)).toEqual(["Beta", "Zulu", "Alpha"]);
    expect(groups.map((group) => group.plans.map((entry) => entry.target))).toEqual([
        ["Web", "Unknown"],
        ["Zoo", "Agent"],
        ["Agent", "Stopped"],
    ]);
    expect(groups.map((group) => group.required)).toEqual([1, 1, 0]);
    expect(restartGroups(plans.toReversed(), "", "all", "all")).toEqual(groups);
    expect(plans).toEqual(before);
});

test("literal multiword search combines host and service with independent filters", () => {
    expect(
        restartGroups(plans, "  bEtA  WEB ", "required", "external")[0]?.plans.map(
            (entry) => entry.target
        )
    ).toEqual(["Web"]);
    expect(restartGroups(plans, "beta", "required", "dashboard")).toEqual([]);
    expect(restartGroups(plans, "[", "all", "all")).toEqual([]);
    expect(
        restartGroups(plans, "", "required", "all").flatMap((group) =>
            group.plans.map((entry) => entry.target)
        )
    ).toEqual(["Web", "Zoo"]);
    expect(
        restartGroups(plans, "", "unknown", "all").flatMap((group) =>
            group.plans.map((entry) => entry.target)
        )
    ).toEqual(["Stopped", "Unknown"]);
    expect(
        restartGroups(plans, "", "not-required", "all").flatMap((group) => group.plans)
    ).toHaveLength(2);
});

test("separate hosts with identical labels stay separate and stable", () => {
    const first = plan("Web", "one", true, { host: { id: "one", label: "Server" } });
    const second = plan("Web", "two", true, { host: { id: "two", label: "Server" } });
    expect(
        restartGroups([second, first], "", "all", "all").map((group) => group.host.id)
    ).toEqual(["one", "two"]);
});
