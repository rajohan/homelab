import "@daypicker/react/style.css";
import { DayPicker } from "@daypicker/react";
import { enGB } from "@daypicker/react/locale";
import { Popover, PopoverButton, PopoverPanel } from "@headlessui/react";
import { CalendarDays, ChevronDown } from "lucide-react";

import { cn } from "../../lib/classNames";
import { formatDateTimeParts } from "../../lib/formatDateTime";
import { FormField } from "../Form/FormField";
import { inputStyles } from "../Input/inputStyles";
import { calendarClasses, calendarStyle } from "./calendarStyles";

/**
 * Choose a browser-local calendar date using the same date display as the dashboard.
 * @returns A labelled calendar popover with keyboard navigation and minimum-date support.
 */
export function DatePicker({
    label,
    value,
    onChange,
    minimumDate,
    disabled = false,
}: {
    readonly label: string;
    readonly value: Date;
    readonly onChange: (date: Date) => void;
    readonly minimumDate?: Date;
    readonly disabled?: boolean;
}) {
    const [displayDate] = formatDateTimeParts(value);
    return (
        <FormField label={label} disabled={disabled}>
            <Popover>
                {({ close }) => (
                    <>
                        <PopoverButton
                            disabled={disabled}
                            aria-label={`Choose ${label}, selected ${displayDate}`}
                            className={cn(
                                inputStyles,
                                "flex items-center gap-2 text-left"
                            )}
                        >
                            <CalendarDays
                                size={16}
                                aria-hidden="true"
                                className="shrink-0 text-primary-400"
                            />
                            <span className="min-w-0 flex-1 truncate">{displayDate}</span>
                            <ChevronDown
                                size={16}
                                aria-hidden="true"
                                className="shrink-0 text-primary-400"
                            />
                        </PopoverButton>
                        <PopoverPanel
                            anchor={{ to: "bottom start", gap: 8, padding: 8 }}
                            className="z-70 max-w-[calc(100vw-1rem)] rounded-lg border border-primary-600 bg-primary-900 p-2 text-sm text-primary-100 shadow-xl shadow-black/40 outline-none"
                        >
                            <DayPicker
                                mode="single"
                                required
                                locale={enGB}
                                navLayout="around"
                                showOutsideDays
                                selected={value}
                                defaultMonth={value}
                                disabled={
                                    minimumDate === undefined
                                        ? undefined
                                        : { before: minimumDate }
                                }
                                classNames={calendarClasses}
                                style={calendarStyle}
                                onSelect={(date) => {
                                    onChange(
                                        new Date(
                                            date.getFullYear(),
                                            date.getMonth(),
                                            date.getDate(),
                                            12
                                        )
                                    );
                                    close();
                                }}
                            />
                        </PopoverPanel>
                    </>
                )}
            </Popover>
        </FormField>
    );
}
