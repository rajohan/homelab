import type { CalendarEvent } from "@homelab/contracts/miraCalendar";
import { EmptyState, SectionPanel } from "@homelab/ui";
import { isSameDay } from "date-fns";
import { Bell, CalendarClock, ChevronRight, MapPin } from "lucide-react";

const dayFormat = new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "long",
});
const time = new Intl.DateTimeFormat("en-GB", { hour: "2-digit", minute: "2-digit" });
const dateTime = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
});

function formatReminder(who: string, instant: string | null, day: Date) {
    if (!instant) return null;
    const date = new Date(instant);
    const clock = isSameDay(date, day) ? time : dateTime;
    return `${who} · ${clock.format(date)}`;
}

/** Present appointments for one day, with the complete time span of overnight events.
 * @param props - Display date, overlapping appointments, query state and edit handler.
 * @returns Daily agenda with an accessible action for each event.
 */
export function CalendarAgenda({
    day,
    events,
    onSelect,
    ready,
}: {
    day: Date;
    events: readonly CalendarEvent[];
    onSelect: (event: CalendarEvent) => void;
    ready: boolean;
}) {
    return (
        <SectionPanel
            title={dayFormat.format(day)}
            icon={CalendarClock}
            className="self-start"
        >
            {events.length > 0 ? (
                <ul className="divide-y divide-primary-700 @min-[44rem]/calendar:max-h-[max(15rem,calc(100dvh-19rem))] @min-[44rem]/calendar:overflow-y-auto">
                    {events.map((event) => {
                        const start = new Date(event.startsAt),
                            end = new Date(event.endsAt);
                        const clock = isSameDay(start, end) ? time : dateTime;
                        const reminders = [
                            formatReminder("You", event.operatorReminderAt, day),
                            formatReminder("Mira", event.miraReminderAt, day),
                        ]
                            .filter(Boolean)
                            .join(" / ");
                        return (
                            <li key={event.id}>
                                <button
                                    className="flex w-full cursor-pointer items-start gap-3 rounded-lg px-2 py-3 text-left hover:bg-primary-800 focus-visible:outline-2 focus-visible:outline-accent-300"
                                    onClick={() => onSelect(event)}
                                >
                                    <span className="min-w-0 flex-1">
                                        <span className="block text-xs font-semibold text-accent-300 tabular-nums">
                                            {event.allDay
                                                ? "All day"
                                                : clock.format(start) +
                                                  " – " +
                                                  clock.format(end)}
                                        </span>
                                        <span className="mt-1 block font-semibold wrap-anywhere text-primary-50">
                                            {event.title}
                                        </span>
                                        {event.location && (
                                            <span className="mt-1 flex items-baseline gap-1.5 text-sm wrap-anywhere text-primary-300">
                                                <MapPin
                                                    size={13}
                                                    className="mt-1 shrink-0 self-start"
                                                    aria-hidden="true"
                                                />
                                                {event.location}
                                            </span>
                                        )}
                                        {event.notes && (
                                            <span className="mt-1 line-clamp-2 text-sm wrap-anywhere text-primary-400">
                                                {event.notes}
                                            </span>
                                        )}
                                        {reminders && (
                                            <span className="mt-2 flex items-start gap-1.5 text-xs leading-5 text-primary-300">
                                                <Bell
                                                    size={13}
                                                    className="mt-0.5 shrink-0"
                                                    aria-hidden="true"
                                                />
                                                <span>
                                                    <span className="sr-only">
                                                        Reminders:{" "}
                                                    </span>
                                                    {reminders}
                                                </span>
                                            </span>
                                        )}
                                    </span>
                                    <ChevronRight
                                        size={16}
                                        className="mt-1 shrink-0 text-primary-400"
                                        aria-hidden="true"
                                    />
                                </button>
                            </li>
                        );
                    })}
                </ul>
            ) : (
                ready && <EmptyState message="No events scheduled for this day." />
            )}
        </SectionPanel>
    );
}
