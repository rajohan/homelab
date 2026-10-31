import { expect, test } from "bun:test";

import {
    deploymentPauseSchema,
    deploymentPolicySchema,
    type DeploymentPolicySummary,
} from "@homelab/contracts/deployment";
import * as v from "valibot";

import { automaticReleaseEligible } from "./deploymentAutomatic";
import { deploymentTestTarget as target, deploymentTestPlan } from "./deploymentFixtures";
import { deploymentWindowEnd } from "./deploymentWindow";

const policy: DeploymentPolicySummary = {
    target: "main",
    version: 1,
    mode: "patch",
    window: { start: "03:00", minutes: 60 },
    timeZone: "Europe/Oslo",
    paused: false,
    reason: null,
    until: null,
    configurationChanged: false,
};
function qualified() {
    const plan = deploymentTestPlan();
    plan.release.dashboardSchema = "f".repeat(64);
    for (const item of Object.values(plan.expected.containers))
        item.dashboardSchema = plan.release.dashboardSchema;
    return plan;
}

test("automatic admission requires newer stable versions and identical migrations on every core service", () => {
    expect(automaticReleaseEligible(policy, target, qualified())).toBe(true);
    for (const change of [
        { mode: "manual" as const },
        { paused: true },
        { configurationChanged: true },
    ])
        expect(
            automaticReleaseEligible({ ...policy, ...change }, target, qualified())
        ).toBe(false);
    for (const version of [
        "1.2.2",
        "1.2.1",
        "1.1.99",
        "2.0.0",
        "1.2.4-rc.1",
        "999999999999999999999.0.0",
    ]) {
        const plan = qualified();
        plan.release.version = version;
        expect(automaticReleaseEligible(policy, target, plan)).toBe(false);
    }
    const minor = qualified();
    minor.release.version = "1.3.0";
    expect(automaticReleaseEligible(policy, target, minor)).toBe(false);
    expect(automaticReleaseEligible({ ...policy, mode: "minor" }, target, minor)).toBe(
        true
    );
    for (const value of [null, "e".repeat(64)]) {
        const plan = qualified();
        plan.expected.containers.mira!.dashboardSchema = value;
        expect(automaticReleaseEligible(policy, target, plan)).toBe(false);
    }
    const legacy = qualified();
    delete legacy.release.dashboardSchema;
    expect(automaticReleaseEligible(policy, target, legacy)).toBe(false);
    for (const image of [
        "ghcr.io/another/repo/dashboard:1.2.2",
        "ghcr.io/demo/homelab/dashboard:1.2.2-rc.1",
        "ghcr.io/demo/homelab/dashboard:1.2.2",
    ]) {
        const plan = qualified();
        plan.expected.containers.dashboard!.image = image;
        expect(automaticReleaseEligible(policy, target, plan)).toBe(false);
    }
    const missing = qualified();
    delete missing.expected.containers.worker;
    expect(automaticReleaseEligible(policy, target, missing)).toBe(false);
});

test("daily windows follow the shared timezone clock, cross midnight and end exclusively", () => {
    expect(deploymentWindowEnd(policy, Date.parse("2026-10-31T01:59:59Z"))).toBeNull();
    expect(deploymentWindowEnd(policy, Date.parse("2026-10-31T02:00:00Z"))).toBe(
        Date.parse("2026-10-31T03:00:00Z")
    );
    expect(deploymentWindowEnd(policy, Date.parse("2026-10-31T03:00:00Z"))).toBeNull();
    expect(
        deploymentWindowEnd(
            { ...policy, window: { start: "23:30", minutes: 120 } },
            Date.parse("2026-11-01T00:15:00Z")
        )
    ).toBe(Date.parse("2026-11-01T00:30:00Z"));
    // Spring's nonexistent local start cannot authorize a deployment; autumn's real local time can.
    const dst = { ...policy, window: { start: "02:30", minutes: 30 } };
    expect(deploymentWindowEnd(dst, Date.parse("2026-03-29T01:45:00Z"))).toBeNull();
    expect(deploymentWindowEnd(dst, Date.parse("2026-10-25T00:45:00Z"))).toBe(
        Date.parse("2026-10-25T01:00:00Z")
    );
});

test("automatic unified release also requires matching Auth migrations and a newer Auth version", () => {
    const combined = {
        ...target,
        auth: {
            ...target,
            id: "auth",
            connection: "edge",
            mira: false as const,
            services: [{ name: "auth", app: "auth" as const }],
        },
    };
    const plan = qualified();
    plan.authExpected = {
        ...plan.expected,
        containers: {
            auth: {
                ...plan.expected.containers.dashboard!,
                image: `ghcr.io/demo/homelab/auth:1.2.2@sha256:${"a".repeat(64)}`,
            },
        },
    };
    expect(automaticReleaseEligible(policy, combined, plan)).toBe(false);
    plan.release.authSchema = "c".repeat(64);
    plan.authExpected.containers.auth!.authSchema = plan.release.authSchema;
    expect(automaticReleaseEligible(policy, combined, plan)).toBe(true);
    plan.authExpected.containers.auth!.authSchema = "d".repeat(64);
    expect(automaticReleaseEligible(policy, combined, plan)).toBe(false);
    plan.authExpected.containers.auth!.authSchema = plan.release.authSchema;
    plan.authExpected.containers.auth!.image =
        plan.authExpected.containers.auth!.image.replace("1.2.2", "1.2.3");
    expect(automaticReleaseEligible(policy, combined, plan)).toBe(false);
});

test("deployment policy inputs reject broad scopes, unbounded windows and unexplained pauses", () => {
    const input = {
        target: "main",
        version: 0,
        mode: "patch",
        window: { start: "03:00", minutes: 60 },
    };
    expect(v.safeParse(deploymentPolicySchema, input).success).toBe(true);
    for (const change of [
        { mode: "all" },
        { version: -1 },
        { window: { start: "24:00", minutes: 60 } },
        { window: { start: "00:00", minutes: 241 } },
    ])
        expect(v.safeParse(deploymentPolicySchema, { ...input, ...change }).success).toBe(
            false
        );
    const pause = {
        target: "main",
        version: 1,
        paused: true,
        reason: "Maintenance",
        until: null,
    };
    expect(v.safeParse(deploymentPauseSchema, pause).success).toBe(true);
    for (const change of [
        { reason: null },
        { reason: " " },
        { paused: false },
        { until: -1 },
    ])
        expect(v.safeParse(deploymentPauseSchema, { ...pause, ...change }).success).toBe(
            false
        );
});
