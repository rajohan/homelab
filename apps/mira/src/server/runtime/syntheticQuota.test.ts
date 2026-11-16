import { expect, test } from "bun:test";

import { readSyntheticQuota, syntheticQuotaWindows } from "./syntheticRuntime";

test("weekly credit regeneration survives validation without displaying a legacy request reset", async () => {
    const request: typeof fetch = Object.assign(
        () =>
            Promise.resolve(
                Response.json({
                    subscription: {
                        limit: 500,
                        requests: 0,
                        renewsAt: "2026-11-16T21:00:00Z",
                    },
                    planWeeklyLimit: {
                        percentRemaining: 36,
                        nextRegenAt: "2026-11-16T14:00:00Z",
                        nextRegenPercent: 2,
                    },
                })
            ),
        { preconnect: fetch.preconnect }
    );
    const quota = await readSyntheticQuota(
        { owner: "fixture", apiKey: "fixture" },
        new AbortController().signal,
        request
    );
    expect(quota).not.toBeNull();
    expect(syntheticQuotaWindows(quota!)).toEqual([
        {
            label: "Weekly credits",
            remainingPercent: 36,
            resetsAt: null,
            replenishesAt: "2026-11-16T14:00:00Z",
            replenishesPercent: 2,
        },
    ]);
});

test("missing regeneration telemetry is not replaced with an invented countdown", () => {
    expect(
        syntheticQuotaWindows({
            subscription: { limit: 500, requests: 0 },
            planWeeklyLimit: { percentRemaining: 0 },
        })
    ).toEqual([{ label: "Weekly credits", remainingPercent: 0, resetsAt: null }]);
    expect(
        syntheticQuotaWindows({
            subscription: { limit: 100, requests: 25, renewsAt: "2026-11-16T21:00:00Z" },
        })
    ).toEqual([
        {
            label: "Subscription requests",
            remainingPercent: 75,
            resetsAt: "2026-11-16T21:00:00Z",
        },
    ]);
});
