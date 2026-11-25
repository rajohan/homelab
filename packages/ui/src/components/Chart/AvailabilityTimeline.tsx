import {
    type ResourceAvailability,
    sumAvailabilityCounts,
    trackedAvailabilityMinutes,
} from "@homelab/contracts/infrastructure";
import { useRef, useState } from "react";

import { formatDateTimeParts } from "../../lib/formatDateTime";
import { ChoiceBar } from "../Select/ChoiceBar";

const ranges = [
    { value: "hour", label: "1h", minutes: 60, size: 1 },
    { value: "day", label: "24h", minutes: 1440, size: 30 },
    { value: "week", label: "7d", minutes: 10_080, size: 180 },
    { value: "month", label: "30d", minutes: 43_200, size: 1440 },
    { value: "year", label: "1y", minutes: 525_600, size: 7200 },
] as const;
type Range = (typeof ranges)[number]["value"];

const states = {
    up: { label: "Up", mark: "h-7 bg-emerald-400" },
    down: {
        label: "Downtime",
        mark: "h-5 rounded-b-none bg-rose-400",
    },
    unknown: {
        label: "No data",
        mark: "h-1.5 bg-primary-400",
    },
} as const;

const readings = {
    up: { label: "Up", color: "bg-emerald-400" },
    down: { label: "Down", color: "bg-rose-400" },
    missed: { label: "No signal", color: "bg-rose-400" },
    unknown: { label: "No data", color: "bg-primary-400" },
};

function currentReading(sample: string | undefined, expected: boolean) {
    if (sample === "1") return readings.up;
    if (sample === "0") return readings.down;
    return expected ? readings.missed : readings.unknown;
}

function timeLabel(ms: number, showDate: boolean) {
    const [date, time] = formatDateTimeParts(ms);
    return (showDate ? date.slice(0, 5) + " " : "") + time.slice(0, 5);
}

const percent = new Intl.NumberFormat(undefined, {
    style: "percent",
    maximumFractionDigits: 2,
});
function ratio(value: number, total: number) {
    if (!total) return "—";
    if (value > 0 && value / total < 0.0001) return "<" + percent.format(0.0001);
    if (value < total && value / total > 0.9999) return ">" + percent.format(0.9999);
    return percent.format(value / total);
}

function minuteCounts(data: string, size: number) {
    const counts = [];
    for (let i = 0; i < data.length; i += size) {
        const chunk = data.slice(i, i + size);
        const available = chunk.split("1").length - 1;
        const down = chunk.split("0").length - 1;
        counts.push({ available, observed: available + down });
    }
    return counts;
}

/** Show the selected period’s measured uptime and its chronological intervals together.
 * @param props - Tracking start, timestamp, recent minute checks and long-range counts for one resource.
 * @returns An interactive timeline with a period selector and inspectable intervals.
 */
export function AvailabilityTimeline({
    history,
}: {
    readonly history: Pick<
        ResourceAvailability,
        "capturedAt" | "periods" | "firstSampleAt" | "monitorUnavailable"
    > &
        Partial<Pick<ResourceAvailability, "recentMinutes" | "longHistory">>;
}) {
    const { capturedAt, recentMinutes = "", longHistory } = history;
    const sliderRef = useRef<HTMLInputElement>(null);
    const [range, setRange] = useState<Range>("day");
    const [selected, setSelected] = useState<number | null>(null);
    const [hovered, setHovered] = useState<number | null>(null);
    const window = ranges.find((option) => option.value === range)!;
    const end = Date.parse(capturedAt);
    const firstMinute =
        history.firstSampleAt === null
            ? null
            : Math.ceil(Date.parse(history.firstSampleAt) / 60_000);
    const first = end - (window.minutes - 1) * 60_000;
    const long = range === "month" || range === "year";
    const data = recentMinutes.slice(-window.minutes);
    const counts =
        range === "month" || range === "year"
            ? (longHistory?.[range] ?? [])
            : minuteCounts(data, window.size);
    const buckets = counts.map(({ available, observed }, i) => {
        const start = first + i * window.size * 60_000;
        const end = start + (window.size - 1) * 60_000;
        const expected = trackedAvailabilityMinutes(
            firstMinute,
            end / 60_000,
            window.size
        );
        const failed = observed - available;
        const missed = history.monitorUnavailable ? 0 : Math.max(0, expected - observed);
        const noData = window.size - observed - missed;
        const down = failed + missed;
        const measuredState = available ? states.up : states.unknown;
        const state = down ? states.down : measuredState;
        return { start, end, up: available, failed, missed, down, noData, state };
    });
    const totals =
        history.periods.find((row) => row.period === range) ??
        sumAvailabilityCounts(counts);
    const expected = trackedAvailabilityMinutes(
        firstMinute,
        end / 60_000,
        window.minutes
    );
    const incomplete = history.monitorUnavailable && totals.observed < expected;
    const uptime = incomplete ? "—" : ratio(totals.available, expected);
    const current = currentReading(
        recentMinutes.at(-1),
        expected > 0 && !history.monitorUnavailable
    );
    const index = Math.min(hovered ?? selected ?? buckets.length - 1, buckets.length - 1);
    const active = buckets[index];
    const showDate =
        range === "week" ||
        long ||
        (active &&
            new Date(active.start).toDateString() !==
                new Date(active.end).toDateString());
    const interval = active
        ? timeLabel(active.start, Boolean(showDate)) +
          (active.end === active.start
              ? ""
              : "–" + timeLabel(active.end, Boolean(showDate)))
        : "";
    const details = active
        ? [
              active.up && active.up + " min up",
              active.failed && active.failed + " min down (failed checks)",
              active.missed && active.missed + " min down (missed checks)",
              active.noData &&
                  active.noData +
                      (history.monitorUnavailable
                          ? " min without data"
                          : " min before tracking"),
          ]
              .filter(Boolean)
              .join(" · ")
        : "";
    const inspecting = hovered !== null || selected !== null;
    const lastDown = buckets.findLastIndex((bucket) => bucket.down > 0);
    const downInterval = buckets[lastDown];
    const detailMinutes =
        !long && downInterval
            ? data.slice(lastDown * window.size, (lastDown + 1) * window.size)
            : "";
    const latestFailedOffset = Math.max(
        detailMinutes.lastIndexOf("0"),
        downInterval?.missed ? detailMinutes.lastIndexOf("?") : -1
    );
    const axisLabel = (ms: number) =>
        long ? formatDateTimeParts(ms)[0] : timeLabel(ms, range !== "hour");
    return (
        <section
            aria-label="Availability timeline"
            className="min-w-0 rounded-lg border border-primary-700 bg-surface-card p-3 sm:p-4"
        >
            <div className="flex flex-wrap items-center justify-between gap-x-5 gap-y-2">
                <div className="flex min-w-0 items-center gap-3 whitespace-nowrap sm:gap-3.5">
                    <span
                        aria-label={"Current status: " + current.label}
                        className="inline-flex items-center gap-2 text-base leading-none font-medium text-primary-100"
                    >
                        <span
                            aria-hidden="true"
                            className={"size-2 rounded-full " + current.color}
                        />
                        {current.label}
                    </span>
                    <span aria-hidden="true" className="h-4 w-px bg-primary-600" />
                    <p
                        aria-label="Period uptime"
                        className="inline-flex items-baseline gap-1.5 leading-none"
                    >
                        <strong className="text-xl leading-none font-semibold tracking-tight text-primary-50 tabular-nums">
                            {uptime}
                        </strong>
                        <span className="text-sm text-primary-300">uptime</span>
                    </p>
                </div>
                <ChoiceBar
                    label="Status history range"
                    value={range}
                    options={
                        recentMinutes
                            ? ranges
                            : ranges.filter((option) => option.value !== "hour")
                    }
                    onChange={(value) => {
                        setRange(value);
                        setSelected(null);
                        setHovered(null);
                    }}
                />
            </div>
            {active ? (
                <>
                    <div className="relative mt-3 flex h-11 items-center gap-px sm:gap-0.5">
                        {buckets.map((bucket, i) => (
                            <span
                                key={bucket.start}
                                aria-hidden="true"
                                className={
                                    "min-w-0 flex-1 rounded-sm " +
                                    bucket.state.mark +
                                    (inspecting && i === index
                                        ? " outline-2 outline-offset-1 outline-primary-50"
                                        : "")
                                }
                            />
                        ))}
                        <input
                            ref={sliderRef}
                            type="range"
                            aria-label="Inspect status interval"
                            aria-valuetext={interval + " · " + details}
                            min={0}
                            max={buckets.length - 1}
                            step={1}
                            value={index}
                            onChange={(event) => {
                                setHovered(null);
                                setSelected(Number(event.target.value));
                            }}
                            onFocus={() =>
                                setSelected((previous) => previous ?? buckets.length - 1)
                            }
                            onBlur={() => setSelected(null)}
                            onPointerMove={(event) => {
                                if (event.pointerType !== "mouse" || event.buttons)
                                    return;
                                const rect = event.currentTarget.getBoundingClientRect();
                                setHovered(
                                    Math.min(
                                        buckets.length - 1,
                                        Math.max(
                                            0,
                                            Math.floor(
                                                ((event.clientX - rect.left) /
                                                    rect.width) *
                                                    buckets.length
                                            )
                                        )
                                    )
                                );
                            }}
                            onPointerLeave={() => setHovered(null)}
                            className="absolute inset-0 m-0 size-full cursor-pointer opacity-0"
                        />
                    </div>
                    <div className="flex justify-between text-xs text-primary-400 tabular-nums">
                        <time dateTime={new Date(first).toISOString()}>
                            {axisLabel(first)}
                        </time>
                        <time dateTime={capturedAt}>{axisLabel(end)}</time>
                    </div>
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-primary-700 pt-3 text-xs">
                        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-primary-300">
                            {Object.entries(states).map(([key, state]) => (
                                <span
                                    key={key}
                                    className="inline-flex items-center gap-1.5"
                                >
                                    <span
                                        aria-hidden="true"
                                        className={
                                            "w-1.5 rounded-sm " +
                                            state.mark +
                                            " max-h-2.5"
                                        }
                                    />
                                    {state.label}
                                </span>
                            ))}
                        </div>
                        {inspecting ? (
                            <span className="text-primary-200 tabular-nums">
                                {interval} · {details}
                            </span>
                        ) : (
                            lastDown !== -1 && (
                                <button
                                    type="button"
                                    className="rounded text-accent-300 hover:underline"
                                    onClick={() => {
                                        sliderRef.current?.focus();
                                        setSelected(lastDown);
                                    }}
                                >
                                    Latest downtime
                                    {downInterval &&
                                        latestFailedOffset !== -1 &&
                                        " · " +
                                            timeLabel(
                                                downInterval.start +
                                                    latestFailedOffset * 60_000,
                                                true
                                            )}
                                </button>
                            )
                        )}
                    </div>
                </>
            ) : (
                <p className="mt-3 text-sm text-primary-400">
                    Interval history unavailable for this period.
                </p>
            )}
        </section>
    );
}
