import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";

import { waitForLiveAssistance } from "./liveAssistance";

function clock() {
    let now = 0;
    return {
        tick: () => {
            now += 10;
        },
        timing: { now: () => now, intervalMs: 30, consentMs: 100, pollMs: 1 },
    };
}

test("live assistance waits between observations and waits for actual local approval", async () => {
    const time = clock();
    let reads = 0;
    const ready = await waitForLiveAssistance(
        () => {
            time.tick();
            reads++;
            return Promise.resolve({
                state: reads < 4 ? ("pending" as const) : ("ready" as const),
            });
        },
        new AbortController().signal,
        null,
        time.timing
    );
    expect(ready).toBe(true);
    expect(reads).toBe(4);
});

test.each(["stopped", "offline", "unavailable"] as const)(
    "live assistance ends on %s without scheduling another observation",
    async (state) => {
        let reads = 0;
        expect(
            await waitForLiveAssistance(
                () => {
                    reads++;
                    return Promise.resolve({ state });
                },
                new AbortController().signal,
                5000,
                clock().timing
            )
        ).toBe(false);
        expect(reads).toBe(1);
    }
);

test("live assistance limits pending consent and leaves time for clean run completion", async () => {
    const time = clock();
    let reads = 0;
    expect(
        await waitForLiveAssistance(
            () => {
                time.tick();
                reads++;
                return Promise.resolve({ state: "waiting" as const });
            },
            new AbortController().signal,
            5000,
            time.timing
        )
    ).toBe(false);
    expect(reads).toBe(10);
    expect(
        await waitForLiveAssistance(
            () => {
                throw new Error("No read should occur near the run deadline");
            },
            new AbortController().signal,
            1020,
            clock().timing
        )
    ).toBe(false);
});

test("cancelling during a readiness read prevents the next provider turn", async () => {
    const stop = new AbortController();
    await rejects(
        waitForLiveAssistance(
            () => {
                stop.abort(new Error("Operator stopped"));
                return Promise.resolve({ state: "ready" as const });
            },
            stop.signal,
            5000,
            clock().timing
        ),
        /Operator stopped/
    );
});
