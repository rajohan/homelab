import { setTimeout as delay } from "node:timers/promises";

import type { MiraComputerReadiness } from "../data/computerWait";

const defaultTiming = {
    intervalMs: 15_000,
    consentMs: 120_000,
    pollMs: 1000,
    now: Date.now,
};

/**
 * Pace a continuation while checking that the operator still shares the computer.
 * @param readiness - Fenced access reader; this function never creates or extends access.
 * @param signal - Current run cancellation and shutdown signal.
 * @param deadlineAt - Existing run deadline, with time reserved for clean completion.
 * @param timing - Short clocks are injectable by isolated tests only.
 * @returns True when another observation is due; false after access loss or the duration ends.
 */
export async function waitForLiveAssistance(
    readiness: () => Promise<MiraComputerReadiness>,
    signal: AbortSignal,
    deadlineAt: number,
    timing = defaultTiming
): Promise<boolean> {
    const next = timing.now() + timing.intervalMs;
    const until = Math.min(deadlineAt - 1000, timing.now() + timing.consentMs);
    if (next >= until) return false;
    for (;;) {
        signal.throwIfAborted();
        const state = await readiness();
        signal.throwIfAborted();
        if (timing.now() >= until) return false;
        if (state.state === "ready" && timing.now() >= next) return true;
        if (!["ready", "waiting", "pending"].includes(state.state)) return false;
        await delay(
            Math.min(timing.pollMs, Math.max(1, until - timing.now())),
            undefined,
            { signal }
        );
    }
}
