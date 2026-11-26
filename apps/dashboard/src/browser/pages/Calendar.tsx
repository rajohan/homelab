import type { CalendarRange } from "@homelab/contracts/miraCalendar";
import { Button, ErrorNotice, LoadingState, PageHeader } from "@homelab/ui";
import { skipToken, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { addDays, endOfMonth, startOfMonth, startOfWeek } from "date-fns";
import { CalendarDays, Plus } from "lucide-react";
import { useState } from "react";
import * as v from "valibot";

import { api } from "../api/client";
import { CalendarAgenda } from "../features/calendar/CalendarAgenda";
import { eventsOnDay, localDay } from "../features/calendar/calendarDays";
import { CalendarEditor } from "../features/calendar/CalendarEditor";
import { calendarLocation } from "../features/calendar/calendarLocation";
import { CalendarMonth } from "../features/calendar/CalendarMonth";

/** Show the calendar shared by the operator and Mira.
 * @returns A responsive month view and daily agenda backed by owned appointments.
 */
export function Calendar() {
    const { event: eventId } = v.parse(
        calendarLocation,
        useSearch({ from: "/calendar" })
    );
    const navigate = useNavigate({ from: "/calendar" });
    const linked = useQuery({
        queryKey: ["operations", "mira", "calendar-event", eventId],
        queryFn: eventId
            ? ({ signal }) => api.mira.calendar.get.query({ id: eventId }, { signal })
            : skipToken,
    });
    const [selected, setDay] = useState(() => new Date());
    const [creating, setCreating] = useState(false);
    const event = eventId ? linked.data : null;
    let day = selected;
    if (event)
        day = event.allDay
            ? localDay(Date.parse(event.startsAt))
            : new Date(event.startsAt);
    const month = startOfMonth(day);
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
        if (eventId) void navigate({ search: {}, resetScroll: false, replace: true });
    };
    const move = (date: Date) => {
        const first = startOfMonth(date);
        setDay(
            new Date(
                first.getFullYear(),
                first.getMonth(),
                Math.min(day.getDate(), endOfMonth(first).getDate())
            )
        );
    };
    return (
        <div className="@container/calendar flex min-w-0 flex-col gap-3">
            <PageHeader
                title="Calendar"
                icon={CalendarDays}
                compactActions
                description="Appointments shared with Mira."
                actions={
                    <Button onClick={() => setCreating(true)}>
                        <Plus size={16} aria-hidden="true" />
                        New event
                    </Button>
                }
            />
            {query.isError && <ErrorNotice error={query.error} />}
            {eventId && linked.isPending && <LoadingState label="Opening event…" />}
            {eventId && linked.isError && <ErrorNotice error={linked.error} />}
            {eventId && linked.isSuccess && !event && (
                <output className="text-sm text-primary-300">
                    This event is no longer available.
                </output>
            )}
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
            <div className="grid min-w-0 items-start gap-3 @min-[44rem]/calendar:grid-cols-[minmax(0,1.9fr)_minmax(14rem,1fr)]">
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
                    onSelect={(item) =>
                        void navigate({ search: { event: item.id }, resetScroll: false })
                    }
                    ready={query.isSuccess && !query.hasNextPage}
                />
            </div>
            {(creating || event) && (
                <CalendarEditor
                    key={event?.id ?? "new"}
                    day={day}
                    event={event ?? undefined}
                    onClose={() => {
                        setCreating(false);
                        setDay(day);
                        if (eventId)
                            void navigate({
                                search: {},
                                resetScroll: false,
                                replace: true,
                            });
                    }}
                />
            )}
        </div>
    );
}
