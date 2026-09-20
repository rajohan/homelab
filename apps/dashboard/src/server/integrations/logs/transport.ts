import type { LogCursor, LogEntry, LogPage } from "@homelab/contracts/logs";
import * as v from "valibot";

import { readBoundedJson } from "../http/readJson";

const logValue = v.tuple([
    v.pipe(v.string(), v.regex(/^[0-9]{19}$/)),
    v.pipe(v.string(), v.maxLength(16_384)),
]);
const logStream = v.object({
    stream: v.record(v.string(), v.string()),
    values: v.pipe(v.array(logValue), v.maxLength(1001)),
});
const responseSchema = v.object({
    status: v.literal("success"),
    data: v.object({
        resultType: v.literal("streams"),
        result: v.pipe(v.array(logStream), v.maxLength(100)),
    }),
});
export interface LogsConfiguration {
    readonly url: string;
    readonly token: string | undefined;
}
export interface LegacyLogSelection {
    readonly labels: Readonly<Record<string, string>>;
    readonly until: string;
}
const periods = {
    "15m": 15 * 60,
    "1h": 3600,
    "6h": 6 * 3600,
    "24h": 24 * 3600,
    "7d": 7 * 24 * 3600,
} as const;

function selector(values: Readonly<Record<string, string>>): string {
    return Object.entries(values)
        .map(([name, value]) => {
            if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(name))
                throw new Error("Invalid configured log label");
            return `${name}=${JSON.stringify(value)}`;
        })
        .join(",");
}

function entries(value: v.InferOutput<typeof responseSchema>): LogEntry[] {
    const occurrences = new Map<string, number>();
    return value.data.result
        .flatMap((stream) =>
            stream.values.map(([timestamp, message]) => {
                const digest = new Bun.CryptoHasher("sha256")
                    .update(
                        JSON.stringify([
                            Object.entries(stream.stream).toSorted(([left], [right]) =>
                                left.localeCompare(right)
                            ),
                            timestamp,
                            message,
                        ])
                    )
                    .digest("hex");
                const occurrence = occurrences.get(digest) ?? 0;
                occurrences.set(digest, occurrence + 1);
                return {
                    id: `${digest}:${occurrence}`,
                    timestamp,
                    message,
                    level: stream.stream.level ?? stream.stream.severity ?? "info",
                };
            })
        )
        .toSorted(
            (left, right) =>
                right.timestamp.localeCompare(left.timestamp) ||
                left.id.localeCompare(right.id)
        );
}

/**
 * Read bounded Loki history using only server-owned labels, never browser-provided LogQL.
 * @param configuration - Trusted read-only Loki endpoint and optional scoped bearer token.
 * @param labels - Exact allowlisted application selectors.
 * @param input - Fixed window and validated continuation cursor.
 * @param signal - Request cancellation/deadline.
 * @param legacy - Server-owned historical mapping ending at a fixed migration cutoff.
 * @returns Complete timestamp groups, so pagination never silently skips colliding timestamps.
 */
export async function readApplicationLogs(
    configuration: LogsConfiguration,
    labels: Readonly<Record<string, string>>,
    input: { range: keyof typeof periods; cursor?: LogCursor; search?: string },
    signal: AbortSignal,
    legacy?: LegacyLogSelection
): Promise<LogPage> {
    const now = BigInt(Date.now()) * 1_000_000n;
    const since = input.cursor
        ? BigInt(input.cursor.since)
        : now - BigInt(periods[input.range]) * 1_000_000_000n;
    const before = input.cursor ? BigInt(input.cursor.before) : now;
    if (
        since < now - 169n * 3600n * 1_000_000_000n ||
        before > now + 60n * 1_000_000_000n ||
        before < since ||
        before - since > 168n * 3600n * 1_000_000_000n
    )
        throw new Error("Log cursor is outside the allowed window");
    if (!selector(labels)) throw new Error("Application log selectors are required");
    const read = async (
        selectedLabels: Readonly<Record<string, string>>,
        start: bigint,
        end: bigint,
        limit: number
    ) => {
        const url = new URL(
            configuration.url.replace(/\/$/, "") + "/loki/api/v1/query_range"
        );
        url.search = new URLSearchParams({
            query: `{${selector(selectedLabels)}}${input.search ? ` |= ${JSON.stringify(input.search)}` : ""}`,
            start: String(start),
            end: String(end),
            direction: "backward",
            limit: String(limit),
        }).toString();
        const response = await fetch(url, {
            signal,
            redirect: "error",
            headers: configuration.token
                ? { Authorization: `Bearer ${configuration.token}` }
                : {},
        });
        const rows = entries(v.parse(responseSchema, await readBoundedJson(response)));
        if (
            rows.length > limit ||
            rows.some(
                (row) => BigInt(row.timestamp) < start || BigInt(row.timestamp) >= end
            )
        )
            throw new Error("Log service returned an invalid result window");
        return rows;
    };
    const legacyTime = legacy ? Date.parse(legacy.until) : null;
    if (legacyTime !== null && (!Number.isFinite(legacyTime) || legacyTime > Date.now()))
        throw new Error("Invalid legacy log cutoff");
    const query = async (start: bigint, end: bigint, limit: number) => {
        const cutoff = legacyTime === null ? start : BigInt(legacyTime) * 1_000_000n;
        const historicalEnd = cutoff < end ? cutoff : end;
        const pages = await Promise.all([
            read(labels, start, end, limit),
            legacy && historicalEnd > start
                ? read(legacy.labels, start, historicalEnd, limit)
                : Promise.resolve([]),
        ]);
        return pages
            .flat()
            .toSorted(
                (left, right) =>
                    right.timestamp.localeCompare(left.timestamp) ||
                    left.id.localeCompare(right.id)
            )
            .slice(0, limit);
    };
    const rows = await query(since, before, 201);
    if (rows.length < 201) return { entries: rows, nextCursor: null };
    const boundary = rows.at(-1)?.timestamp;
    if (!boundary) throw new Error("Log cursor is unavailable");
    const complete = rows.filter((row) => row.timestamp > boundary);
    if (complete.length > 0)
        return {
            entries: complete,
            nextCursor: { since: String(since), before: String(BigInt(boundary) + 1n) },
        };
    // Loki log ranges are [start, end), not metric-style inclusive bounds:
    // https://grafana.com/docs/loki/latest/reference/loki-http-api/#query-logs-within-a-range-of-time
    // One nanosecond covers exactly this timestamp; the next page excludes it.
    const group = await query(BigInt(boundary), BigInt(boundary) + 1n, 1001);
    if (group.length > 1000)
        throw new Error(
            "More than 1,000 log entries share a timestamp; refine the log source before continuing."
        );
    const next = BigInt(boundary);
    return {
        entries: group,
        nextCursor: next <= since ? null : { since: String(since), before: String(next) },
    };
}
