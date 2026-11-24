import { DayButton, type DayButtonProps } from "@daypicker/react";
import { useContext } from "react";

import { eventsOnDay } from "./calendarDays";
import { MonthEvents } from "./MonthEvents";

/** Render a keyboard-focusable day with its first appointment and overflow count.
 * @param props - DayPicker's date, selection and native interaction handlers.
 * @returns A full-width date cell with an accessible event count.
 */
export function CalendarDayButton({
    day,
    modifiers,
    children,
    ...props
}: DayButtonProps) {
    const events = eventsOnDay(useContext(MonthEvents), day.date);
    return (
        <DayButton
            {...props}
            day={day}
            modifiers={modifiers}
            aria-label={`${props["aria-label"] ?? day.date.toLocaleDateString()}${events.length > 0 ? `, ${events.length} ${events.length === 1 ? "event" : "events"}` : ""}`}
            className={`group relative flex min-h-11 w-full cursor-pointer flex-col items-center justify-start gap-1 rounded-lg px-1 py-1.5 text-sm focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-accent-300 sm:min-h-21 sm:items-start sm:px-2 ${modifiers.selected ? "bg-accent-900/60 text-accent-100 ring-1 ring-accent-400 ring-inset" : "hover:bg-primary-800"} ${modifiers.outside ? "text-primary-500" : "text-primary-100"}`}
        >
            <span
                className={`inline-flex size-6 items-center justify-center rounded-full font-medium tabular-nums ${modifiers.today ? "bg-accent-700 text-white" : ""}`}
            >
                {children}
            </span>
            {events.length > 0 && (
                <>
                    <span
                        className="size-1.5 rounded-full bg-accent-300 sm:hidden"
                        aria-hidden="true"
                    />
                    <span className="hidden max-w-full truncate text-left text-xs font-medium text-accent-200 sm:block">
                        {events[0]?.title}
                    </span>
                    {events.length > 1 && (
                        <span className="hidden text-xs text-primary-300 sm:block">
                            +{events.length - 1}
                        </span>
                    )}
                </>
            )}
        </DayButton>
    );
}
