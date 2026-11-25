import { readMinuteSamples, type RetainedEra } from "./availabilityHistory";
import type { MetricsConfiguration } from "./transport";

const minutesPerDay = 1440;
export const timelineMinutes = 7 * minutesPerDay;

/** Decode the recent archive into chronological minute states, retaining gaps.
 * @param endMinute - Last included UTC minute since epoch.
 * @param days - Daily observed and healthy bitmaps from the summary's database snapshot.
 * @returns One week ending at endMinute, including unobserved minutes before the first sample.
 */
export function archivedTimeline(
    endMinute: number,
    days: readonly (readonly [number, string, string | null])[]
): string {
    const first = endMinute - timelineMinutes + 1;
    const minutes = Array.from({ length: timelineMinutes }, () => "?");
    for (const [day, observed, healthy] of days) {
        if (healthy === null) continue;
        const start = day * minutesPerDay;
        for (
            let at = Math.max(start, first);
            at <= Math.min(start + minutesPerDay - 1, endMinute);
            at++
        ) {
            const offset = at - start;
            if (observed[offset] === "1")
                minutes[at - first] = healthy[offset] === "1" ? "1" : "0";
        }
    }
    return minutes.join("");
}

/** Fill unresolved recent minutes from the monitor and count each new point in the same period totals.
 * @param config - Read-only monitor connection.
 * @param eras - Valid resource identities restricted to the unreconciled dates.
 * @param start - Exclusive start of the timeline in Unix seconds.
 * @param archived - Known archive minutes in chronological order.
 * @param periods - Counts of retained observations missing from the durable archive.
 * @param signal - Existing request deadline.
 * @returns The merged sequence; a failed read leaves the caller's archived sequence intact.
 */
export async function completeTimeline(
    config: MetricsConfiguration,
    eras: readonly RetainedEra[],
    start: number,
    archived: string,
    periods: { start: number; observed: number; available: number }[],
    signal: AbortSignal
): Promise<string> {
    const minutes = Array.from({ length: archived.length }, (_, index) =>
        archived.charAt(index)
    );
    for (const era of eras) {
        let from = Math.max(start, era.after, Math.ceil(era.first / 60) * 60 - 60);
        while (from < era.until) {
            const until = Math.min(era.until, from + minutesPerDay * 60);
            const offset = (from - start) / 60;
            const chunk = archived.slice(offset, (until - start) / 60);
            const gap = chunk.indexOf("?");
            if (gap !== -1) {
                const points = await readMinuteSamples(
                    config,
                    era.expression,
                    from + gap * 60,
                    from + (chunk.lastIndexOf("?") + 1) * 60,
                    signal
                );
                for (const [at, state] of points) {
                    const index = (at - start) / 60 - 1;
                    if (minutes[index] !== "?") continue;
                    minutes[index] = String(state);
                    for (const period of periods) {
                        if (at <= period.start) continue;
                        period.observed++;
                        period.available += state;
                    }
                }
            }
            from = until;
        }
    }
    return minutes.join("");
}
