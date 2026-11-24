import type { CalendarEvent, CalendarRange } from "@homelab/contracts/miraCalendar";
import { Button, ErrorNotice, LoadingState, PageHeader } from "@homelab/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { addDays, endOfMonth, isSameMonth, startOfMonth, startOfWeek } from "date-fns";
import { CalendarDays, Plus } from "lucide-react";
import { useState } from "react";

import { api } from "../api/client";
import { CalendarAgenda } from "../features/calendar/CalendarAgenda";
import { eventsOnDay } from "../features/calendar/calendarDays";
import { CalendarEditor } from "../features/calendar/CalendarEditor";
import { CalendarMonth } from "../features/calendar/CalendarMonth";

/** Show the calendar shared by the operator and Mira.
 * @returns A responsive month view and daily agenda backed by owned appointments.
 */
export function Calendar() {
    const [day, setDay] = useState(() => new Date());
    const [month, setMonth] = useState(() => startOfMonth(new Date()));
    const [edit, setEdit] = useState<CalendarEvent | "new" | null>(null);
    const start = startOfWeek(startOfMonth(month), { weekStartsOn: 1 });
    const end = addDays(start, 42);
    const range = {
        start: start.toISOString(),
        end: end.toISOString(),
        timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
    const query = useInfiniteQuery({
        queryKey: ["operations", "mira", "calendar", range],
        initialPageParam: undefined as CalendarRange["after"],
        queryFn: ({ pageParam, signal }) =>
            api.mira.calendar.list.query(
                { ...range, ...(pageParam ? { after: pageParam } : {}) },
                { signal }
            ),
        getNextPageParam: (page) => page.next ?? undefined,
        refetchInterval: 15_000,
    });
    const events = query.data?.pages.flatMap((page) => page.items) ?? [];
    const select = (date: Date) => {
        setDay(date);
        if (!isSameMonth(date, month)) setMonth(startOfMonth(date));
    };
    const move = (date: Date) => {
        const first = startOfMonth(date);
        setMonth(first);
        setDay(
            new Date(
                first.getFullYear(),
                first.getMonth(),
                Math.min(day.getDate(), endOfMonth(first).getDate())
            )
        );
    };
    return (
        <div className="flex min-w-0 flex-col gap-4">
            <PageHeader
                title="Calendar"
                icon={CalendarDays}
                description="Appointments shared with Mira."
                actions={
                    <Button onClick={() => setEdit("new")}>
                        <Plus size={16} aria-hidden="true" />
                        New event
                    </Button>
                }
            />
            {query.isError && <ErrorNotice error={query.error} />}
            {query.isPending && <LoadingState label="Loading calendar…" />}
            {query.hasNextPage && (
                <Button
                    variant="secondary"
                    busy={query.isFetchingNextPage}
                    onClick={() => void query.fetchNextPage()}
                >
                    Load more events for this month
                </Button>
            )}
            <div className="grid min-w-0 items-start gap-4 xl:grid-cols-[minmax(0,1.9fr)_minmax(18rem,1fr)]">
                <CalendarMonth
                    month={month}
                    selected={day}
                    events={events}
                    onSelect={select}
                    onMonth={move}
                />
                <CalendarAgenda
                    day={day}
                    events={eventsOnDay(events, day)}
                    onSelect={setEdit}
                    ready={query.isSuccess && !query.hasNextPage}
                />
            </div>
            {edit && (
                <CalendarEditor
                    day={day}
                    event={edit === "new" ? undefined : edit}
                    onClose={() => setEdit(null)}
                />
            )}
        </div>
    );
}
