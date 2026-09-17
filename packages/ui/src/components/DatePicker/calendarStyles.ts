import { DayFlag, SelectionState, UI, getDefaultClassNames } from "@daypicker/react";
import type { CSSProperties } from "react";

import { cn } from "../../lib/classNames";

const defaults = getDefaultClassNames();
const calendarButton =
    "rounded-md transition-colors hover:enabled:bg-primary-700! focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-400 disabled:cursor-not-allowed";

export const calendarClasses = {
    [DayFlag.disabled]: cn(defaults[DayFlag.disabled], "text-primary-600"),
    [DayFlag.outside]: cn(defaults[DayFlag.outside], "text-primary-400"),
    [DayFlag.today]: cn(defaults[DayFlag.today], "text-accent-300"),
    [SelectionState.selected]: cn(
        defaults[SelectionState.selected],
        "[&>button]:bg-accent-600! [&>button]:text-white! [&>button]:hover:bg-accent-700!"
    ),
    [UI.CaptionLabel]: cn(defaults[UI.CaptionLabel], "text-base text-primary-100"),
    [UI.DayButton]: cn(defaults[UI.DayButton], calendarButton, "rounded-full!"),
    [UI.Chevron]: cn(defaults[UI.Chevron], "fill-white!"),
    [UI.NextMonthButton]: cn(defaults[UI.NextMonthButton], calendarButton),
    [UI.PreviousMonthButton]: cn(defaults[UI.PreviousMonthButton], calendarButton),
    [UI.Weekday]: cn(defaults[UI.Weekday], "text-primary-300"),
};

export const calendarStyle = {
    "--rdp-accent-background-color": "var(--color-accent-900)",
    "--rdp-accent-color": "var(--color-accent-300)",
    "--rdp-today-color": "var(--color-accent-300)",
    "--rdp-selected-border": "2px solid transparent",
    "--rdp-day-height": "2.5rem",
    "--rdp-day-width": "min(2.5rem, calc((100vw - 4rem) / 7))",
    "--rdp-day_button-height": "2.375rem",
    "--rdp-day_button-width": "calc(var(--rdp-day-width) - 0.125rem)",
} as CSSProperties;
