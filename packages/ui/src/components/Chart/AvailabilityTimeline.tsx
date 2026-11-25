import {
    type ResourceAvailability,
    sumAvailabilityCounts,
    trackedAvailabilityMinutes,
} from "@homelab/contracts/infrastructure";
import { useId, useRef, useState } from "react";

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

function intervalKey(key: string, index: number, count: number) {
    const page = Math.max(1, Math.round(count / 10));
    const positions: Readonly<Record<string, number>> = {
        Home: 0,
        End: count - 1,
        ArrowLeft: index - 1,
        ArrowDown: index - 1,
        ArrowRight: index + 1,
        ArrowUp: index + 1,
        PageDown: index - page,
        PageUp: index + page,
    };
    const next = positions[key];
    return typeof next === "number" ? Math.min(count - 1, Math.max(0, next)) : null;
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
    const trackRef = useRef<HTMLFieldSetElement>(null);
    const detailsId = useId();
    const [focusIndex, setFocusIndex] = useState<number | null>(null);
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
    function focusInterval(i: number) {
        const button = trackRef.current?.elements.item(i);
        if (button instanceof HTMLButtonElement) button.focus({ preventScroll: true });
    }
    function intervalAt(clientX: number) {
        const rect = trackRef.current!.getBoundingClientRect();
        return Math.max(
            0,
            Math.min(
                buckets.length - 1,
                Math.floor(((clientX - rect.left) / rect.width) * buckets.length)
            )
        );
    }
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
                        setFocusIndex(null);
                        setSelected(null);
                        setHovered(null);
                    }}
                />
            </div>
            {active ? (
                <>
                    <fieldset
                        ref={trackRef}
                        aria-label="Inspect status intervals"
                        className="mt-3 flex h-11 min-w-0"
                        onPointerLeave={() => setHovered(null)}
                        onPointerCancel={() => setHovered(null)}
                    >
                        {buckets.map((bucket, i) => (
                            <button
                                key={i}
                                type="button"
                                aria-label={
                                    timeLabel(bucket.start, range !== "hour") +
                                    " · " +
                                    bucket.state.label
                                }
                                aria-pressed={selected === i}
                                aria-describedby={
                                    inspecting && i === index ? detailsId : undefined
                                }
                                tabIndex={
                                    i === (selected ?? focusIndex ?? buckets.length - 1)
                                        ? 0
                                        : -1
                                }
                                className="group flex h-full min-w-0 flex-1 cursor-pointer touch-pan-y items-center px-[0.5px] select-none focus-visible:outline-none sm:px-px"
                                onFocus={(event) => {
                                    setFocusIndex(i);
                                    if (event.currentTarget.matches(":focus-visible"))
                                        setHovered(i);
                                }}
                                onBlur={() => setHovered(null)}
                                onPointerEnter={(event) => {
                                    if (
                                        selected === null &&
                                        event.pointerType === "mouse" &&
                                        !event.buttons
                                    )
                                        setHovered(i);
                                }}
                                onPointerDown={(event) => {
                                    if (event.isPrimary && event.button === 0)
                                        event.currentTarget.setPointerCapture(
                                            event.pointerId
                                        );
                                }}
                                onPointerMove={(event) => {
                                    if (
                                        event.buttons === 1 &&
                                        event.currentTarget.hasPointerCapture(
                                            event.pointerId
                                        )
                                    )
                                        setHovered(intervalAt(event.clientX));
                                }}
                                onClick={(event) => {
                                    const target = event.detail
                                        ? intervalAt(event.clientX)
                                        : i;
                                    if (target !== i) focusInterval(target);
                                    setFocusIndex(target);
                                    setSelected((previous) =>
                                        previous === target && target === i
                                            ? null
                                            : target
                                    );
                                    setHovered(null);
                                }}
                                onKeyDown={(event) => {
                                    const next = intervalKey(
                                        event.key,
                                        i,
                                        buckets.length
                                    );
                                    if (next === null) return;
                                    event.preventDefault();
                                    focusInterval(next);
                                    setHovered(next);
                                    if (selected !== null) setSelected(next);
                                }}
                            >
                                <span
                                    aria-hidden="true"
                                    className={
                                        "pointer-events-none w-full rounded-sm group-focus-visible:ring-1 group-focus-visible:ring-primary-400 " +
                                        bucket.state.mark +
                                        (inspecting && i === index
                                            ? " outline-2 outline-offset-1 outline-primary-50"
                                            : "")
                                    }
                                />
                            </button>
                        ))}
                    </fieldset>
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
                            <span
                                id={detailsId}
                                className="text-primary-200 tabular-nums"
                            >
                                {interval} · {details}
                            </span>
                        ) : (
                            lastDown !== -1 && (
                                <button
                                    type="button"
                                    className="rounded text-accent-300 hover:underline"
                                    onClick={() => {
                                        focusInterval(lastDown);
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
