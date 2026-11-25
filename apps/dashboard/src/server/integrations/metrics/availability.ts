import {
    type AvailabilityCounts,
    type AvailabilityKind,
    type AvailabilityPeriod,
    availabilityRetentionDays,
    type InfrastructureInventory,
    type ResourceAvailability,
    sumAvailabilityCounts,
    trackedAvailabilityMinutes,
} from "@homelab/contracts/infrastructure";
import type { SQL } from "bun";

import { OperationFailure } from "../../operations/errors";
import { readAvailabilityArchive } from "./availabilityArchive";
import {
    addUnarchivedMinutes,
    availabilityEras,
    retainedEras,
} from "./availabilityHistory";
import { completeTimeline, timelineMinutes } from "./availabilityTimeline";
import type { MetricsConfiguration } from "./transport";

const day = 86_400;
const ttl = 5 * 60_000;

async function collect(
    client: SQL,
    config: MetricsConfiguration | undefined,
    eras: ReturnType<typeof availabilityEras>,
    kind: AvailabilityKind,
    id: string
): Promise<ResourceAvailability> {
    const end = Math.floor((Date.now() / 1000 - 30) / 60) * 60;
    const archive = await readAvailabilityArchive(client, kind, id, end);
    const intervals = archive.intervals;
    let recentMinutes = archive.recentMinutes;
    let first = archive.first;
    let monitorUnavailable = !config;
    if (config) {
        // Merge durable and retained history minute-for-minute in the unreconciled tail.
        const retained = intervals.map((row) => ({ ...row, available: 0, observed: 0 }));
        try {
            const signal = AbortSignal.timeout(25_000);
            const raw = await retainedEras(
                config,
                eras,
                end,
                signal,
                Math.max(
                    end - availabilityRetentionDays * day,
                    (archive.nextDay ?? 0) * day - 60
                )
            );
            const windowStart = end - timelineMinutes * 60;
            await addUnarchivedMinutes(
                config,
                raw.map((era) => ({ ...era, until: Math.min(era.until, windowStart) })),
                archive.masks,
                archive.nextDay,
                retained,
                signal
            );
            recentMinutes = await completeTimeline(
                config,
                raw,
                windowStart,
                recentMinutes,
                retained,
                signal
            );
            for (const era of raw)
                first = first === null ? era.first : Math.min(first, era.first);
            for (const [index, row] of retained.entries()) {
                const period = intervals[index];
                if (period) {
                    period.available += row.available;
                    period.observed += row.observed;
                }
            }
        } catch (error) {
            if (archive.first === null) throw error;
            monitorUnavailable = true;
        }
    } else if (archive.first === null) {
        throw new OperationFailure(
            "PRECONDITION_FAILED",
            "Availability history has not been collected for this resource."
        );
    }
    const month = intervals.slice(-30);
    const year: AvailabilityCounts[] = intervals
        .slice(0, -30)
        .map(({ available, observed }) => ({ available, observed }));
    for (let index = 0; index < month.length; index += 5)
        year.push(sumAvailabilityCounts(month.slice(index, index + 5)));
    const firstMinute = first === null ? null : Math.ceil(first / 60);
    function periodTotal(
        period: AvailabilityPeriod,
        days: number,
        rows: AvailabilityCounts[]
    ) {
        const totals = sumAvailabilityCounts(rows);
        return {
            period,
            ...totals,
            expected: trackedAvailabilityMinutes(firstMinute, end / 60, days * 1440),
        };
    }
    return {
        measure: eras.at(-1)!.source.measure,
        capturedAt: new Date(end * 1000).toISOString(),
        firstSampleAt: first === null ? null : new Date(first * 1000).toISOString(),
        stepSeconds: 60,
        recentMinutes,
        monitorUnavailable,
        longHistory: {
            month: month.map(({ available, observed }) => ({ available, observed })),
            year,
        },
        periods: [
            periodTotal("day", 1, month.slice(-1)),
            periodTotal("week", 7, month.slice(-7)),
            periodTotal("month", 30, month),
            periodTotal("year", availabilityRetentionDays, year),
        ],
    };
}

interface CacheEntry {
    readonly result: Promise<ResourceAvailability>;
    readonly expires: number;
    pending: boolean;
}
const caches = new WeakMap<SQL, Map<string, CacheEntry>>();

/** Read observed health for one validated resource, sharing work and limiting expensive long-range reads.
 * @param client - Database containing the durable history and isolating its request cache.
 * @param config - Optional server-owned monitoring connection for unresolved history.
 * @param inventory - Trusted inventory from which the queried resource must originate.
 * @param kind - Resource category selected by the operator.
 * @param id - Opaque resource identity from the inventory.
 * @returns Observed minute history, rolling intervals and their covered totals.
 */
export function readAvailability(
    client: SQL,
    config: MetricsConfiguration | undefined,
    inventory: InfrastructureInventory,
    kind: AvailabilityKind,
    id: string
) {
    const eras = availabilityEras(inventory, kind, id);
    const cache = caches.get(client) ?? new Map<string, CacheEntry>();
    caches.set(client, cache);
    const key = JSON.stringify([kind, id]);
    const now = Date.now();
    for (const [old, entry] of cache)
        if (!entry.pending && entry.expires <= now) cache.delete(old);
    const existing = cache.get(key);
    if (existing) return existing.result;
    if ([...cache.values()].filter((entry) => entry.pending).length >= 4)
        throw new OperationFailure(
            "TOO_MANY_REQUESTS",
            "Other availability histories are loading. Please try again shortly."
        );
    if (cache.size >= 128) {
        const oldest = [...cache].find(([, entry]) => !entry.pending);
        if (oldest) cache.delete(oldest[0]);
    }
    const entry: CacheEntry = {
        expires: now + ttl,
        pending: true,
        result: collect(client, config, eras, kind, id)
            .catch((error: unknown) => {
                cache.delete(key);
                throw error;
            })
            .finally(() => {
                entry.pending = false;
            }),
    };
    cache.set(key, entry);
    return entry.result;
}
