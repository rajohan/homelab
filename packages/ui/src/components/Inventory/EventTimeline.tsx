import { Check, CircleAlert, Info, TriangleAlert } from "lucide-react";
import type { ReactNode } from "react";

import { formatDateTimeParts } from "../../lib/formatDateTime";
import type { InfiniteScrollContinuation } from "../InfiniteScrollTrigger/InfiniteScrollTrigger";
import { ScrollList } from "../ScrollList/ScrollList";
import { BreakableName } from "./BreakableName";

type EventTone = "positive" | "warning" | "danger" | "neutral";
const marks = {
    positive: "border-emerald-300 bg-emerald-300",
    warning: "border-amber-300 bg-amber-300",
    danger: "border-rose-400 bg-rose-400",
    neutral: "border-primary-400 bg-primary-900",
};
const feedMarks = {
    positive: { icon: Check, color: "text-emerald-300" },
    warning: { icon: TriangleAlert, color: "text-amber-300" },
    danger: { icon: CircleAlert, color: "text-rose-300" },
    neutral: { icon: Info, color: "text-primary-400" },
};
const dayLabel = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
});

/** Lay out recorded events by day, keeping exact times and existing detail links within reach.
 * @returns A chronological list with status markers, dates and optional event controls.
 */
export function EventTimeline({
    events,
    presentation = "timeline",
    scroll,
}: {
    readonly scroll?: { label: string; continuation: InfiniteScrollContinuation };
    readonly presentation?: "timeline" | "feed";
    readonly events: readonly {
        id: string;
        time: string;
        title: ReactNode;
        badge?: ReactNode;
        detail: ReactNode;
        tone: EventTone;
        label?: string | undefined;
    }[];
}) {
    const feed = presentation === "feed";
    const renderEvent = (event: (typeof events)[number], index: number) => {
        const [date, time] = formatDateTimeParts(event.time);
        const previous = events[index - 1];
        const newDay = !previous || date !== formatDateTimeParts(previous.time)[0];
        const marker = feedMarks[event.tone];
        return (
            <>
                {newDay && (
                    <p
                        className={
                            feed
                                ? "pb-1 text-xs font-medium text-primary-400"
                                : "pt-3 pb-2 text-xs font-semibold text-primary-300"
                        }
                    >
                        {feed && Number.isFinite(Date.parse(event.time))
                            ? dayLabel.format(new Date(event.time))
                            : date}
                    </p>
                )}
                <div
                    className={
                        feed
                            ? "relative ml-2 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-baseline gap-x-2 border-l border-primary-700 py-1 pl-5"
                            : "relative ml-1 grid min-w-0 grid-cols-[3.8rem_minmax(0,1fr)] gap-2 border-l border-primary-700 py-2 pl-4"
                    }
                >
                    <span
                        aria-hidden="true"
                        className="pointer-events-none absolute top-0 left-0 row-start-1 grid h-lh -translate-x-1/2 place-items-center text-sm"
                    >
                        {feed ? (
                            <span
                                className={`grid size-5 place-items-center rounded-full bg-primary-900 ${marker.color}`}
                            >
                                <marker.icon size={14} />
                            </span>
                        ) : (
                            <span
                                className={`size-2 rounded-full border ${marks[event.tone]}`}
                            />
                        )}
                    </span>
                    <span className="inline-flex items-baseline gap-2 text-xs leading-5 text-primary-400">
                        <time dateTime={event.time} className="tabular-nums">
                            {time}
                        </time>
                        {feed && <span aria-hidden="true">·</span>}
                    </span>
                    <div className="min-w-0 text-sm">
                        <div className="flex items-baseline gap-2">
                            <div className="min-w-0 font-medium wrap-anywhere text-primary-50">
                                <BreakableName>{event.title}</BreakableName>
                            </div>
                            {event.badge && <div className="shrink-0">{event.badge}</div>}
                        </div>
                        <div
                            className={`flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-xs leading-relaxed wrap-anywhere text-primary-400 ${feed ? "pb-1" : "mt-0.5 empty:hidden"}`}
                        >
                            {event.label && (
                                <span className={marker.color}>{event.label}</span>
                            )}
                            {event.detail && (
                                <div className="min-w-0">{event.detail}</div>
                            )}
                        </div>
                    </div>
                </div>
            </>
        );
    };
    if (events.length === 0 && !scroll) return null;
    if (scroll)
        return (
            <ScrollList
                label={scroll.label}
                rows={events}
                getKey={(event) => event.id}
                renderItem={renderEvent}
                continuation={scroll.continuation}
                className="@container/events"
                itemClassName="pe-scrollbar-inset pb-0"
            />
        );
    return (
        <ol className="@container/events min-w-0">
            {events.map((event, index) => (
                <li key={event.id}>{renderEvent(event, index)}</li>
            ))}
        </ol>
    );
}
