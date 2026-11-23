import { Children, type ReactNode } from "react";

import { cn } from "../../lib/classNames";
import { actionGroupContainer, actionGroupStyles } from "./actionGroupStyles";

/**
 * Lay out actions in reading and keyboard order. Use a vertical list for choices that have a preferred order.
 * @param props - Related controls, optional spacing, sizing and layout.
 * @returns Equal-height actions that wrap according to their available space.
 */
export function ActionGroup({
    children,
    className,
    align = "end",
    stretch = true,
    stacked = false,
}: {
    readonly children: ReactNode;
    readonly className?: string;
    readonly align?: "start" | "end";
    readonly stretch?: boolean;
    readonly stacked?: boolean;
}) {
    if (Children.toArray(children).length === 0) return null;
    return (
        <div className={cn(actionGroupContainer, className)}>
            <div
                data-ui="action-group"
                className={actionGroupStyles(stretch, stacked, align)}
            >
                {children}
            </div>
        </div>
    );
}
