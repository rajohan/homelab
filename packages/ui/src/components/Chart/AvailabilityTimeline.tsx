import { CircleCheck, CircleHelp, CircleX } from "lucide-react";
import { useRef, useState } from "react";

import { formatDateTimeParts } from "../../lib/formatDateTime";
import { ChoiceBar } from "../Select/ChoiceBar";

const ranges = [
    { value: "hour", label: "1h", minutes: 60, size: 1 },
    { value: "day", label: "24h", minutes: 1440, size: 30 },
    { value: "week", label: "7d", minutes: 10_080, size: 180 },
] as const;
type Range = (typeof ranges)[number]["value"];

const states = {
    up: { label: "Up", color: "text-emerald-300", mark: "h-7 bg-emerald-400" },
    down: {
        label: "Downtime",
        color: "text-rose-300",
        mark: "h-5 rounded-b-none bg-rose-400",
    },
    partial: {
        label: "Partial coverage",
        color: "text-amber-300",
        mark: "h-3.5 bg-amber-400",
    },
    unknown: {
        label: "No data",
        color: "text-primary-400",
        mark: "h-1.5 bg-primary-400",
    },
} as const;

function intervalState(up: number, down: number, missing: number) {
    if (down) return states.down;
    if (!up) return states.unknown;
    return missing ? states.partial : states.up;
}

const readings = {
    "1": { label: "Up", color: states.up.color, icon: CircleCheck },
    "0": { label: "Down", color: states.down.color, icon: CircleX },
    "?": { label: "No data", color: states.unknown.color, icon: CircleHelp },
};

function timeLabel(ms: number, showDate: boolean) {
    const [date, time] = formatDateTimeParts(ms);
    return (showDate ? date.slice(0, 5) + " " : "") + time.slice(0, 5);
}

/** Show recent minute checks in time order and expose every interval to mouse, touch and keyboard.
 * @param props - Chronological one-minute checks (1 up, 0 down, ? unknown), their final timestamp and the measured condition.
 * @returns A range selector, an inspectable status history and the time of the latest observation.
 */
export function AvailabilityTimeline({
    minutes,
    capturedAt,
    measure,
}: {
    readonly minutes: string;
    readonly capturedAt: string;
    readonly measure: string;
}) {
    const sliderRef = useRef<HTMLInputElement>(null);
    const [range, setRange] = useState<Range>("day");
    const [selected, setSelected] = useState<number | null>(null);
    const [hovered, setHovered] = useState<number | null>(null);
    const window = ranges.find((option) => option.value === range)!;
    const data = minutes.slice(-window.minutes);
    const end = Date.parse(capturedAt);
    const first = end - (data.length - 1) * 60_000;
    const timestamp = (index: number) => first + index * 60_000;
    const buckets = [];
    for (let index = 0; index < data.length; index += window.size) {
        const chunk = data.slice(index, index + window.size);
        const up = chunk.split("1").length - 1;
        const down = chunk.split("0").length - 1;
        const missing = chunk.length - up - down;
        buckets.push({
            state: intervalState(up, down, missing),
            up,
            down,
            missing,
            start: timestamp(index),
            end: timestamp(index + chunk.length - 1),
        });
    }
    const last = data.at(-1);
    const current = readings[last === "1" || last === "0" ? last : "?"];
    const Icon = current.icon;
    const index = Math.min(hovered ?? selected ?? buckets.length - 1, buckets.length - 1);
    const active = buckets[index];
    const showDate =
        range === "week" ||
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
              active.down && active.down + " min down",
              active.missing && active.missing + " min unobserved",
          ]
              .filter(Boolean)
              .join(" · ")
        : "";
    const inspecting = hovered !== null || selected !== null;
    const lastDown = data.lastIndexOf("0");
    return (
        <section
            aria-label="Availability timeline"
            className="min-w-0 rounded-lg border border-primary-700 bg-surface-card p-3 sm:p-4"
        >
            <div className="flex flex-wrap items-start justify-between gap-x-5 gap-y-2">
                <div className="min-w-0">
                    <div
                        className={
                            "flex items-center gap-2 text-lg font-semibold " +
                            current.color
                        }
                    >
                        <Icon size={19} aria-hidden="true" />
                        {current.label}
                    </div>
                    <p className="mt-0.5 text-sm text-primary-300">{measure}</p>
                </div>
                <ChoiceBar
                    label="Status history range"
                    value={range}
                    options={ranges}
                    onChange={(value) => {
                        setRange(value);
                        setSelected(null);
                        setHovered(null);
                    }}
                />
            </div>
            {active && (
                <>
                    <div className="group relative mt-3 flex h-11 items-center gap-px rounded-sm focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent-400 sm:gap-0.5">
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
                            className="absolute inset-0 m-0 size-full cursor-crosshair opacity-0"
                        />
                    </div>
                    <div className="flex justify-between text-xs text-primary-400 tabular-nums">
                        <time dateTime={new Date(first).toISOString()}>
                            {timeLabel(first, range !== "hour")}
                        </time>
                        <time dateTime={capturedAt}>
                            {timeLabel(end, range !== "hour")}
                        </time>
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
                                        setSelected(Math.floor(lastDown / window.size));
                                    }}
                                >
                                    Latest downtime ·{" "}
                                    {timeLabel(timestamp(lastDown), true)}
                                </button>
                            )
                        )}
                    </div>
                </>
            )}
        </section>
    );
}
