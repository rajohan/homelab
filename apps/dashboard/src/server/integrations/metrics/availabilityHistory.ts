import type {
    AvailabilityKind,
    InfrastructureInventory,
} from "@homelab/contracts/infrastructure";

import { availabilitySource, exporterSource } from "./availabilitySource";
import { type MetricsConfiguration, queryMetrics } from "./transport";

const day = 86_400;
type Source = ReturnType<typeof availabilitySource>;
type Window = { start: number; available: number; observed: number };
type Era = { source: Source; after: number; until: number };
const migrations = {
    "homelab-services": {
        project: "stremio",
        until: Date.parse("2026-11-24T16:38Z") / 1000,
        names: "aiometadata aiostreams bitmagnet comet crosswatch flaresolverr gluetun gost jackett mediaflow submaker valkey-cache valkey-submaker".split(
            " "
        ),
    },
    "homelab-tools": {
        project: "tools",
        until: Date.parse("2026-11-24T16:36Z") / 1000,
        names: "it-tools openspeedtest shlink shlink-web valkey-shlink".split(" "),
    },
} as const;
const formerUnits: Readonly<Record<string, string>> = {
    "homelab-services.service": "stremio-apps.service",
    "homelab-services-backends.service": "stremio-backends.service",
    "homelab-services-network-guard.service": "stremio-network-guard.service",
    "homelab-tools.service": "tools-apps.service",
    "homelab-tools-backends.service": "tools-backends.service",
};

/** Resolve only proven historical label changes, with non-overlapping UTC cutovers.
 * @param inventory - Server-owned current identities.
 * @param kind - Resource category.
 * @param id - Current resource ID.
 * @returns Non-overlapping observation eras, ordered oldest first.
 */
export function availabilityEras(
    inventory: InfrastructureInventory,
    kind: AvailabilityKind,
    id: string
): Era[] {
    const current = availabilitySource(inventory, kind, id);
    let previous: Source | undefined;
    let cutoff = 0;
    if (kind === "application") {
        const app = inventory.applications.find((r) => r.id === id);
        const migration =
            app?.project === "homelab-tools" || app?.project === "homelab-services"
                ? migrations[app.project]
                : undefined;
        if (app?.host === "main" && migration?.names.includes(app.name)) {
            cutoff = migration.until;
            previous = availabilitySource(
                { ...inventory, applications: [{ ...app, project: migration.project }] },
                kind,
                id
            );
        }
    } else if (kind === "service") {
        const unit = inventory.services.find((r) => r.id === id);
        const name = unit && formerUnits[unit.name];
        if (unit?.host === "main" && unit.kind === "service" && name) {
            cutoff = Date.parse("2026-11-24T17:52Z") / 1000;
            previous = availabilitySource(
                { ...inventory, services: [{ ...unit, name }] },
                kind,
                id
            );
        }
    }
    return [
        ...(previous ? [{ source: previous, after: 0, until: cutoff }] : []),
        { source: current, after: cutoff, until: Infinity },
    ];
}
export interface RetainedEra {
    readonly first: number;
    readonly after: number;
    readonly until: number;
    readonly expression: string;
}

/** Discover the retained beginning using raw timestamps from the exact resource.
 * @param config - Server monitor connection.
 * @param eras - Reviewed identities and their UTC validity intervals.
 * @param end - Last completed minute, in Unix seconds.
 * @param signal - Shared operation deadline.
 * @param after - Skip minutes already reconciled into the permanent archive.
 * @returns Measured eras with resolved exporter identities and no target labels exposed.
 */
export async function retainedEras(
    config: MetricsConfiguration,
    eras: readonly Era[],
    end: number,
    signal: AbortSignal,
    after = 0
) {
    const result: RetainedEra[] = [];
    for (const era of eras) {
        const until = Math.min(end, era.until);
        const lower = Math.max(after, era.after);
        const span = until - lower;
        if (span <= 0) continue;
        const source = era.source;
        const exporter = "exporter" in source ? source : null;
        const firstExpr = `tfirst_over_time(${source.identity}[${span}s])`;
        const data = await queryMetrics(
            config,
            exporter ? firstExpr : `min(${firstExpr})`,
            signal,
            false,
            until
        );
        if (data.resultType !== "vector")
            throw new Error("Invalid availability timestamp response");
        const matches = exporter
            ? data.result.filter(
                  (row) =>
                      new Bun.CryptoHasher("sha256")
                          .update(row.metric.instance ?? "")
                          .digest("hex")
                          .slice(0, 16) === exporter.exporterHash
              )
            : data.result;
        if (matches.length === 0) continue;
        const first = Math.min(...matches.map((row) => Number(row.value[1])));
        if (!Number.isFinite(first) || first <= 0 || first > until)
            throw new Error("Invalid availability timestamp");
        const instance = matches[0]?.metric.instance;
        result.push({
            first,
            after: lower,
            until,
            expression:
                exporter && instance !== undefined
                    ? exporterSource(exporter.exporter, instance).value
                    : source.value,
        });
    }
    return result;
}

/** Fetch actual binary minute checkpoints for one resource and one bounded part of a UTC day.
 * @param config - Server monitor configuration.
 * @param era - Expression for a single identity and time interval.
 * @param after - Exclusive lower minute, in seconds.
 * @param until - Inclusive upper minute, in seconds.
 * @param signal - Caller deadline.
 * @returns Observed checkpoints only, with no gap filling.
 */
export async function readMinuteSamples(
    config: MetricsConfiguration,
    era: string,
    after: number,
    until: number,
    signal: AbortSignal
) {
    if (until <= after || until - after > day)
        throw new Error("Invalid availability day interval");
    const response = await queryMetrics(
        config,
        `(${era})[${until - after}s:60s]`,
        signal,
        false,
        until,
        true
    );
    if (response.resultType !== "matrix" || response.result.length > 1)
        throw new Error("Invalid availability day");
    const samples = new Map<number, number>();
    for (const [timestamp, raw] of response.result[0]?.values ?? []) {
        if (timestamp <= after || timestamp > until) continue;
        if (!Number.isInteger(timestamp / 60) || samples.has(timestamp))
            throw new Error("Invalid availability checkpoint");
        const state = Number(raw);
        if (state === 0 || state === 1) samples.set(timestamp, state);
    }
    return samples;
}

async function addRange(
    config: MetricsConfiguration,
    expression: string,
    after: number,
    until: number,
    periods: Window[],
    signal: AbortSignal
) {
    const splits = [
        ...new Set([
            after,
            ...periods.map((p) => Math.min(until, Math.max(after, p.start))),
            until,
        ]),
    ].toSorted((a, b) => a - b);
    for (let i = 1; i < splits.length; i++) {
        let from = splits[i - 1]!,
            limit = splits[i]!;
        while (from < limit) {
            const to = Math.min(limit, from + 32_000 * 60);
            const q = `count_values_over_time("availability_state", (${expression})[${to - from}s:60s])`;
            const rows = await queryMetrics(config, q, signal, false, to);
            if (rows.resultType !== "vector")
                throw new Error("Invalid availability counters");
            const counts = new Map<string, number>();
            for (const item of rows.result) {
                const k = item.metric.availability_state,
                    n = Number(item.value[1]);
                if (k !== "0" && k !== "1") continue;
                if (counts.has(k) || !Number.isSafeInteger(n) || n < 0)
                    throw new Error("Invalid availability count");
                counts.set(k, n);
            }
            const healthy = counts.get("1") ?? 0,
                observed = healthy + (counts.get("0") ?? 0);
            if (observed > (to - from) / 60)
                throw new Error("Overlapping availability observations");
            for (const p of periods)
                if (from >= p.start) {
                    p.available += healthy;
                    p.observed += observed;
                }
            from = to;
        }
    }
}

/** Combine raw history with the exact minutes already persisted, counting each minute once.
 * @param config - Read-only monitoring configuration.
 * @param eras - Retained verified identities.
 * @param masks - Durable observed-minute bitmaps for dates not yet reconciled.
 * @param nextDay - First unreconciled UTC day, or null before the background pass.
 * @param periods - Disjoint additions to the caller's minute counts.
 * @param signal - Overall request budget.
 */
export async function addUnarchivedMinutes(
    config: MetricsConfiguration,
    eras: RetainedEra[],
    masks: ReadonlyMap<number, string>,
    nextDay: number | null,
    periods: Window[],
    signal: AbortSignal
) {
    for (const era of eras) {
        let cursor = Math.max(
            Math.ceil(era.first / 60) * 60 - 60,
            era.after,
            nextDay === null ? 0 : nextDay * day - 60
        );
        if (cursor >= era.until) continue;
        for (const [date, observed] of masks) {
            const dayStart = date * day - 60,
                dayEnd = dayStart + day;
            if (dayEnd <= cursor || dayStart >= era.until) continue;
            if (cursor < dayStart)
                await addRange(config, era.expression, cursor, dayStart, periods, signal);
            const after = Math.max(cursor, dayStart),
                until = Math.min(dayEnd, era.until);
            const lo = (after - dayStart) / 60,
                hi = (until - dayStart) / 60;
            const states = new Set(observed.slice(lo, hi));
            if (!states.has("1"))
                await addRange(config, era.expression, after, until, periods, signal);
            else if (states.has("0")) {
                const points = await readMinuteSamples(
                    config,
                    era.expression,
                    after,
                    until,
                    signal
                );
                for (const [timestamp, state] of points)
                    if (observed[(timestamp - date * day) / 60] === "0")
                        for (const p of periods)
                            if (timestamp > p.start) {
                                p.available += state;
                                p.observed++;
                            }
            }
            cursor = until;
        }
        if (cursor < era.until)
            await addRange(config, era.expression, cursor, era.until, periods, signal);
    }
}
