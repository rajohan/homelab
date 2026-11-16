import { expect, test } from "bun:test";

import {
    readSyntheticQuota,
    syntheticQuotaAvailable,
    syntheticQuotaWindows,
    syntheticSubscriptionAvailable,
} from "./syntheticRuntime";

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

test.each([
    [100, 100, 36, true],
    [100, 0, 0, false],
    [100, 99.5, undefined, false],
    [100, 99, undefined, true],
] as const)(
    "availability follows the same current quota model as the display (%s/%s, weekly %s)",
    async (limit, requests, weekly, available) => {
        const quota = {
            subscription: { limit, requests },
            ...(weekly === undefined
                ? {}
                : { planWeeklyLimit: { percentRemaining: weekly } }),
        };
        const request: typeof fetch = Object.assign(
            () => Promise.resolve(Response.json(quota)),
            { preconnect: fetch.preconnect }
        );
        expect(syntheticQuotaAvailable(quota)).toBe(available);
        expect(
            await syntheticSubscriptionAvailable(
                { owner: "fixture", apiKey: "fixture" },
                new AbortController().signal,
                request
            )
        ).toBe(available);
        expect(syntheticQuotaWindows(quota)[0]?.remainingPercent).toBe(
            weekly ?? 100 * (1 - requests / limit)
        );
    }
);
