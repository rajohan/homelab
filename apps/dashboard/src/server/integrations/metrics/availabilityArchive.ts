import {
    type AvailabilityKind,
    availabilityRetentionDays,
    type InfrastructureInventory,
} from "@homelab/contracts/infrastructure";
import type { SQL, TransactionSQL } from "bun";

import {
    type AvailabilitySignal,
    availabilitySource,
    exporterSource,
} from "./availabilitySource";
import { archivedTimeline, timelineMinutes } from "./availabilityTimeline";
import { type MetricsConfiguration, queryMetrics } from "./transport";

const minuteSeconds = 60,
    minutesPerDay = 1440;
export const resourceCollections = {
    host: "hosts",
    application: "applications",
    service: "services",
    storage: "storage",
    diskHealth: "diskHealth",
    network: "networks",
    filesystem: "filesystems",
} as const;
const healthSelectors = [
    '{__name__=~"up|pve_up|probe_success|homelab_app_expected|homelab_app_present|homelab_app_running|homelab_app_ready|homelab_app_collector_success|homelab_app_last_run_timestamp_seconds|smartctl_device_smart_status|node_network_up|node_filesystem_device_error"}',
    'node_systemd_unit_state{state="active",name=~".+[.]service",name!~"user@.+"}',
    'homeassistant_entity_available{entity=~"sensor[.]system_monitor_disk_(use|free)_.+"}',
];
type Sample = {
    readonly metric: Readonly<Record<string, string>>;
    readonly value: number;
};
interface ArchiveRow {
    kind: AvailabilityKind;
    resource: string;
    status: number | null;
}

// Project each distinct metric/dimension combination only once per checkpoint.
function indexReadings(samples: readonly Sample[]) {
    const indices = new Map<string, Map<string, number | null>>();
    return (signal: AvailabilitySignal) => {
        const dimensions = Object.keys(signal.labels).toSorted();
        const shape = JSON.stringify([signal.metric, dimensions]);
        const key = (labels: Readonly<Record<string, string>>) =>
            JSON.stringify(dimensions.map((label) => labels[label] ?? null));
        let index = indices.get(shape);
        if (!index) {
            index = new Map<string, number | null>();
            for (const sample of samples) {
                if (sample.metric.__name__ !== signal.metric) continue;
                const id = key(sample.metric);
                index.set(
                    id,
                    index.has(id) || !Number.isFinite(sample.value) ? null : sample.value
                );
            }
            indices.set(shape, index);
        }
        return index.get(key(signal.labels)) ?? null;
    };
}

/** Collect one exact, fresh minute of binary states in bounded metric-family batches.
 * @param config - Server-owned monitoring connection.
 * @param inventory - Resource identities to record in this checkpoint.
 * @param signal - Existing worker lease and deadline.
 * @returns UTC checkpoint and deduplicated monitored states, including unknowns.
 */
export async function collectAvailabilityCheckpoint(
    config: MetricsConfiguration,
    inventory: InfrastructureInventory,
    signal: AbortSignal
) {
    const at = Math.floor((Date.parse(inventory.capturedAt) / 1000 - 30) / 60) * 60;
    const results = await Promise.all(
        healthSelectors.map((selector) =>
            queryMetrics(
                config,
                `last_over_time(${selector}[1m]) keep_metric_names`,
                signal,
                false,
                at
            )
        )
    );
    const samples = results.flatMap((response) => {
        if (response.resultType !== "vector")
            throw new Error("Invalid monitoring checkpoint");
        return response.result.map((sample) => ({
            metric: sample.metric,
            value: Number(sample.value[1]),
        }));
    });
    const read = indexReadings(samples);
    const instances = new Map(
        samples
            .filter((s) => s.metric.__name__ === "up")
            .map((s) => [
                new Bun.CryptoHasher("sha256")
                    .update(s.metric.instance ?? "")
                    .digest("hex")
                    .slice(0, 16),
                s.metric.instance ?? "",
            ])
    );
    const rows = new Map<string, ArchiveRow>();
    for (const kind of Object.keys(resourceCollections) as AvailabilityKind[]) {
        const collection = resourceCollections[kind];
        for (const row of inventory[collection]) {
            let source = availabilitySource(inventory, kind, row.id);
            if ("exporter" in source) {
                const instance =
                    source.exporterHash && instances.get(source.exporterHash);
                if (instance !== undefined)
                    source = exporterSource(source.exporter, instance);
            }
            const states = source.signals.map(read);
            const timestamp = source.freshness ? read(source.freshness) : at;
            const valid =
                !("exporter" in source) &&
                states.every((value) => value === 1 || value === 0) &&
                source.guards.every((gate) => read(gate) === 1) &&
                timestamp !== null &&
                at - timestamp < 180 &&
                at - timestamp >= -60;
            const measured = valid
                ? Number(states.every((value) => value === (source.inverted ? 0 : 1)))
                : null;
            const key = JSON.stringify([kind, row.id]);
            rows.set(key, {
                kind,
                resource: row.id,
                status: rows.has(key) ? null : measured,
            });
        }
    }
    return { minute: at / minuteSeconds, rows: [...rows.values()] };
}

/** Persist a fenced worker checkpoint with at most one observation per resource and UTC minute.
 * @param tx - Existing snapshot transaction after checking the worker lease.
 * @param checkpoint - Server-measured binary states, never interpolated across missing worker runs.
 */
export async function saveAvailabilityCheckpoint(
    tx: TransactionSQL,
    checkpoint: Awaited<ReturnType<typeof collectAvailabilityCheckpoint>>
) {
    const day = Math.floor(checkpoint.minute / minutesPerDay),
        slot = checkpoint.minute % minutesPerDay;
    await tx`WITH saved AS (INSERT INTO availability_days (kind,resource,day,first_minute,observed,healthy)
        SELECT kind,resource,${day}::int,${slot}::int,
            set_bit(B'0'::bit(1440), ${slot}::int, (status IS NOT NULL)::int),
            set_bit(B'0'::bit(1440), ${slot}::int, CASE WHEN status=1 THEN 1 ELSE 0 END)
        FROM jsonb_to_recordset(${JSON.stringify(checkpoint.rows)}::text::jsonb) AS states(kind text,resource text,status integer)
        ON CONFLICT (kind,resource,day) DO UPDATE SET
            first_minute=least(availability_days.first_minute,excluded.first_minute),
            observed=availability_days.observed | excluded.observed,
            healthy=availability_days.healthy | (excluded.healthy & ~availability_days.observed)
        WHERE excluded.first_minute < availability_days.first_minute OR
            (get_bit(availability_days.observed,${slot}::int)=0 AND get_bit(excluded.observed,${slot}::int)=1)
        RETURNING kind,resource,first_minute)
        INSERT INTO availability_backfill AS cursor(kind,resource,next_day,first_minute)
        SELECT kind,resource,${day - availabilityRetentionDays}::int,${checkpoint.minute}::int FROM saved WHERE first_minute=${slot}::int
        ON CONFLICT(kind,resource) DO UPDATE SET first_minute=excluded.first_minute
        WHERE cursor.first_minute IS NULL OR cursor.first_minute>excluded.first_minute`;
}

/** Count observed archive minutes in rolling windows, including exact partial-day edges.
 * @param client - Dashboard database.
 * @param kind - Validated monitored resource category.
 * @param id - Exact inventory identity.
 * @param end - Most recent completed checkpoint in Unix seconds.
 * @returns The earliest archived checkpoint and counts from persistent daily bitmaps.
 */
export async function readAvailabilityArchive(
    client: SQL,
    kind: AvailabilityKind,
    id: string,
    end: number
) {
    const minute = Math.floor(end / minuteSeconds);
    // One day per interval over the last month and five days per interval before it.
    // Both spans end at the selected minute rather than at midnight.
    const firstMinute = minute - availabilityRetentionDays * minutesPerDay;
    const monthStart = minute - 30 * minutesPerDay;
    const intervals = [];
    for (let start = firstMinute; start < minute;) {
        const end = start + (start < monthStart ? 5 : 1) * minutesPerDay;
        intervals.push({ start, end });
        start = end;
    }
    const rows = await client<
        {
            start: number;
            end: number;
            first: number | null;
            observed: number;
            available: number;
            next_day: number | null;
            masks: [number, string, string | null][] | null;
        }[]
    >`
        WITH cursor_state AS (SELECT next_day,first_minute FROM availability_backfill WHERE kind=${kind} AND resource=${id}),
        periods AS (SELECT * FROM jsonb_to_recordset(${JSON.stringify(intervals)}::text::jsonb) AS p(start int,"end" int)),
        days AS (SELECT day*1440 AS start,first_minute,observed,healthy FROM availability_days WHERE kind=${kind} AND resource=${id} AND day BETWEEN ${Math.floor((firstMinute + 1) / minutesPerDay)} AND ${Math.floor(minute / minutesPerDay)})
        SELECT p.start,p."end",(SELECT next_day FROM cursor_state) AS next_day,
            CASE WHEN p.start=${firstMinute} THEN (SELECT jsonb_agg(jsonb_build_array(start/1440,observed::text,
                CASE WHEN start+1439 > ${minute - timelineMinutes} THEN healthy::text END) ORDER BY start)
              FROM days WHERE start/1440>=coalesce((SELECT next_day FROM cursor_state),0)
                OR start+1439 > ${minute - timelineMinutes}) END AS masks,
            least((SELECT first_minute FROM cursor_state), min(d.start+d.first_minute) FILTER (WHERE d.start+d.first_minute <= ${minute}))::int AS first,
            coalesce(sum(bit_count(substring(d.observed from edge.lo+1 for greatest(0,edge.hi-edge.lo+1)))),0)::int AS observed,
            coalesce(sum(bit_count(substring(d.healthy from edge.lo+1 for greatest(0,edge.hi-edge.lo+1)))),0)::int AS available
        FROM periods p LEFT JOIN days d ON d.start+1439>p.start AND d.start<=p."end"
        CROSS JOIN LATERAL (SELECT greatest(0,p.start+1-d.start) AS lo,least(1439,p."end"-d.start) AS hi) edge
        GROUP BY p.start,p."end" ORDER BY p.start`;
    const meta = rows[0];
    const firsts = rows.flatMap((row) => (row.first === null ? [] : [row.first]));
    return {
        first: firsts.length > 0 ? Math.min(...firsts) * minuteSeconds : null,
        intervals: rows.map(({ start, end, available, observed }) => ({
            start: start * minuteSeconds,
            end: end * minuteSeconds,
            available,
            observed,
        })),
        nextDay: meta?.next_day ?? null,
        masks: new Map((meta?.masks ?? []).map(([day, observed]) => [day, observed])),
        recentMinutes: archivedTimeline(minute, meta?.masks ?? []),
    };
}
