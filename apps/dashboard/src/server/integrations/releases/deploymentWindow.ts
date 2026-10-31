import type { DeploymentPolicySummary } from "@homelab/contracts/deployment";
import { nextScheduleOccurrence } from "@homelab/scheduling";

/**
 * Locate the current daily maintenance window using the existing shared timezone scheduler.
 * @param policy - Explicit daily start, bounded duration and qualified system timezone.
 * @param now - Current wall-clock milliseconds.
 * @returns The exclusive end of the active window, or null outside it, including DST gaps.
 */
export function deploymentWindowEnd(
    policy: Pick<DeploymentPolicySummary, "window" | "timeZone">,
    now: number
): number | null {
    const localTime = new Intl.DateTimeFormat("en-GB", {
        timeZone: policy.timeZone,
        hourCycle: "h23",
        hour: "2-digit",
        minute: "2-digit",
    });
    let cursor = now - 27 * 3_600_000,
        latest: number | null = null;
    for (let count = 0; count < 5; count++) {
        const next = nextScheduleOccurrence(
            { kind: "daily", time: policy.window.start },
            cursor,
            cursor,
            policy.timeZone
        ).getTime();
        if (next > now) break;
        if (localTime.format(new Date(next)) === policy.window.start) latest = next;
        cursor = next;
    }
    const end = latest === null ? null : latest + policy.window.minutes * 60_000;
    return end !== null && end > now ? end : null;
}
