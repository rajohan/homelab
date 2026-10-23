import { Children, type ReactNode } from "react";

import { useMediaQuery } from "../../hooks/useMediaQuery";
import { cn } from "../../lib/classNames";

/**
 * Keep related actions together, with full-width buttons when space requires stacking.
 * @param props - Action buttons, optional spacing and whether desktop buttons fill the row.
 * @returns Responsive actions with the first child above secondary actions on mobile and to their right on wider screens.
 */
export function ActionGroup({
    children,
    className,
    stretch = true,
}: {
    readonly children: ReactNode;
    readonly className?: string;
    readonly stretch?: boolean;
}) {
    const wide = useMediaQuery("(min-width: 30rem)");
    const actions = Children.toArray(children);
    const ordered =
        wide && actions.length > 1 ? [...actions.slice(1), actions[0]] : actions;
    return (
        <div className={className}>
            <div
                className={cn(
                    "flex flex-col justify-end gap-2 min-[30rem]:flex-row min-[30rem]:flex-wrap [&>button]:w-full [&>button]:max-w-full [&>button]:min-w-min min-[30rem]:[&>button]:w-auto",
                    stretch &&
                        "min-[30rem]:[&>button]:flex-1 min-[30rem]:[&>button:last-child]:flex-2"
                )}
            >
                {ordered}
            </div>
        </div>
    );
}
