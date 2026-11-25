import {
    type AvailabilityKind,
    availabilityRetentionDays,
    type InfrastructureInventory,
} from "@homelab/contracts/infrastructure";
import type { SQL, TransactionSQL } from "bun";

import { resourceCollections } from "./availabilityArchive";
import { availabilityEras, readMinuteSamples, retainedEras } from "./availabilityHistory";
import type { MetricsConfiguration } from "./transport";

const secondsPerDay = 86_400,
    minutesPerDay = 1440;
interface Work {
    kind: AvailabilityKind;
    resource: string;
    next_day: number | null;
}
interface CompletedDay {
    kind: AvailabilityKind;
    resource: string;
    next_day: number;
    day: number;
    first: number;
    observed: string;
    healthy: string;
}

async function recover(
    config: MetricsConfiguration,
    inventory: InfrastructureInventory,
    task: Work,
    today: number,
    signal: AbortSignal
): Promise<CompletedDay> {
    const firstDay =
        Math.floor(Date.parse(inventory.capturedAt) / (secondsPerDay * 1000)) -
        availabilityRetentionDays;
    const nextDay = Math.max(task.next_day ?? firstDay, firstDay);
    const eras = await retainedEras(
        config,
        availabilityEras(inventory, task.kind, task.resource),
        Math.floor(Date.now() / 60_000) * 60 - 60,
        signal,
        nextDay * secondsPerDay - 60
    );
    const earliest = eras[0]?.first;
    // Do not reacquire days already outside the rolling archive.
    const day =
        earliest === undefined
            ? today
            : Math.max(nextDay, Math.floor(earliest / secondsPerDay));
    const observed = Array.from({ length: minutesPerDay }, () => "0"),
        healthy = Array.from({ length: minutesPerDay }, () => "0");
    let first = minutesPerDay;
    if (day < today) {
        for (const era of eras) {
            const firstIdentityMinute = Math.ceil(era.first / 60) - day * minutesPerDay;
            if (firstIdentityMinute >= 0 && firstIdentityMinute < minutesPerDay)
                first = Math.min(first, firstIdentityMinute);
            const after = Math.max(
                day * secondsPerDay - 60,
                era.after,
                Math.ceil(era.first / 60) * 60 - 60
            );
            const until = Math.min((day + 1) * secondsPerDay - 60, era.until);
            if (after >= until) continue;
            const points = await readMinuteSamples(
                config,
                era.expression,
                after,
                until,
                signal
            );
            for (const [time, value] of points) {
                const minute = (time - day * secondsPerDay) / 60;
                observed[minute] = "1";
                healthy[minute] = String(value);
                first = Math.min(first, minute);
            }
        }
    }
    return {
        kind: task.kind,
        resource: task.resource,
        day,
        next_day: Math.min(today, day + 1),
        first,
        observed: observed.join(""),
        healthy: healthy.join(""),
    };
}

/** Recover a bounded number of resource-days without competing with normal monitoring.
 * @param client - Database storing durable per-resource progress.
 * @param config - Read-only monitoring connection.
 * @param inventory - Latest known resource identities.
 * @param signal - Deadline shared by this small background batch.
 * @returns Only successful reads and an independent failure count. Failed reads do not advance.
 */
export async function collectAvailabilityBackfill(
    client: SQL,
    config: MetricsConfiguration,
    inventory: InfrastructureInventory,
    signal: AbortSignal
) {
    const minute = Math.floor(Date.parse(inventory.capturedAt) / 60_000);
    // Give late observations ten minutes to arrive before reconciling the previous day.
    const today = Math.floor((minute - 10) / minutesPerDay);
    const live = (Object.keys(resourceCollections) as AvailabilityKind[]).flatMap(
        (kind) =>
            inventory[resourceCollections[kind]].map((row) => ({
                kind,
                resource: row.id,
            }))
    );
    const tasks = await client<Work[]>`
        WITH live AS (SELECT DISTINCT kind,resource FROM jsonb_to_recordset(${JSON.stringify(live)}::text::jsonb) AS i(kind text,resource text))
        SELECT live.kind,live.resource,c.next_day FROM live LEFT JOIN availability_backfill c USING(kind,resource)
        WHERE c.next_day IS NULL OR c.next_day < ${today}
        ORDER BY CASE WHEN ${minute}::int % 5<>0 THEN coalesce(c.next_day,0) END,
            md5(live.kind||live.resource||${String(minute)}) LIMIT 12`;
    const days: CompletedDay[] = [];
    let failed = 0;
    for (let i = 0; i < tasks.length && !signal.aborted; i += 3) {
        const results = await Promise.allSettled(
            tasks
                .slice(i, i + 3)
                .map((task) => recover(config, inventory, task, today, signal))
        );
        for (const result of results) {
            if (result.status === "fulfilled") days.push(result.value);
            else failed++;
        }
    }
    return { days, failed };
}

/** Merge only new observations and commit their recovery cursors in the same worker transaction.
 * @param tx - Fenced worker commit.
 * @param days - Successfully reconciled resource-days, including genuine empty days.
 */
export async function saveAvailabilityBackfill(
    tx: TransactionSQL,
    days: readonly CompletedDay[]
) {
    if (days.length === 0) return;
    await tx`WITH batch AS (
        SELECT * FROM jsonb_to_recordset(${JSON.stringify(days)}::text::jsonb)
        AS b(kind text,resource text,day int,next_day int,first int,observed text,healthy text)
    ), persisted AS (
        INSERT INTO availability_days(kind,resource,day,first_minute,observed,healthy)
        SELECT kind,resource,day,first,observed::bit(1440),healthy::bit(1440) FROM batch WHERE first<1440
        ON CONFLICT (kind,resource,day) DO UPDATE SET first_minute=least(availability_days.first_minute,excluded.first_minute),
            healthy=availability_days.healthy | (excluded.healthy & ~availability_days.observed),
            observed=availability_days.observed | excluded.observed
    )
    INSERT INTO availability_backfill AS cursor(kind,resource,next_day,first_minute)
    SELECT kind,resource,next_day,CASE WHEN first<1440 THEN day*1440+first END FROM batch
    ON CONFLICT(kind,resource) DO UPDATE SET next_day=greatest(cursor.next_day,excluded.next_day),
        first_minute=least(cursor.first_minute,excluded.first_minute)`;
}
