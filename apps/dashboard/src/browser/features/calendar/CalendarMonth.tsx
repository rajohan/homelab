import { DayPicker } from "@daypicker/react";
import { enGB } from "@daypicker/react/locale";
import type { CalendarEvent } from "@homelab/contracts/miraCalendar";
import { Button, IconButton, SectionPanel } from "@homelab/ui";
import { addMonths, startOfMonth } from "date-fns";
import { CalendarDays, ChevronLeft, ChevronRight } from "lucide-react";

import { CalendarDayButton } from "./CalendarDayButton";
import { MonthEvents } from "./MonthEvents";

const monthFormat = new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" });
const components = { DayButton: CalendarDayButton };
/** Display a keyboard-navigable month and its events with a compact mobile layout.
 * @param props - Selected date, visible month, loaded events and navigation handlers.
 * @returns Month grid using the same calendar library as dashboard form controls.
 */
export function CalendarMonth({
    selected,
    month,
    events,
    onSelect,
    onMonth,
}: {
    selected: Date;
    month: Date;
    events: readonly CalendarEvent[];
    onSelect: (d: Date) => void;
    onMonth: (d: Date) => void;
}) {
    return (
        <SectionPanel
            icon={CalendarDays}
            title={monthFormat.format(month)}
            actions={
                <div className="flex items-center gap-1">
                    <IconButton
                        size="sm"
                        icon={ChevronLeft}
                        label="Previous month"
                        onClick={() => onMonth(addMonths(month, -1))}
                    />
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => onSelect(new Date())}
                    >
                        Today
                    </Button>
                    <IconButton
                        size="sm"
                        icon={ChevronRight}
                        label="Next month"
                        onClick={() => onMonth(addMonths(month, 1))}
                    />
                </div>
            }
        >
            <MonthEvents value={events}>
                <DayPicker
                    mode="single"
                    required
                    locale={enGB}
                    month={startOfMonth(month)}
                    selected={selected}
                    onSelect={onSelect}
                    onMonthChange={onMonth}
                    showOutsideDays
                    fixedWeeks
                    hideNavigation
                    components={components}
                    classNames={{
                        root: "min-w-0",
                        months: "w-full",
                        month: "w-full",
                        month_caption: "sr-only",
                        month_grid: "w-full table-fixed border-collapse",
                        weekday:
                            "py-2 text-center text-xs font-medium text-primary-400 sm:px-2 sm:text-left",
                        day: "border-t border-primary-700/70 p-0.5 align-top sm:p-1",
                        today: "",
                        selected: "",
                        outside: "",
                    }}
                />
            </MonthEvents>
        </SectionPanel>
    );
}
