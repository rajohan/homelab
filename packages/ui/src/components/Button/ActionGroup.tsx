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
        <div className={cn("@container/actions", className)}>
            <div
                className={cn(
                    "flex flex-col justify-end gap-2 [&>:is(button,a)]:w-full [&>:is(button,a)]:max-w-full [&>:is(button,a)]:min-w-min",
                    stretch
                        ? "min-[30rem]:flex-row min-[30rem]:flex-wrap min-[30rem]:[&>:is(button,a)]:w-auto min-[30rem]:[&>:is(button,a)]:flex-1 min-[30rem]:[&>:is(button,a):last-child]:flex-2"
                        : "@min-[40rem]/actions:flex-row @min-[40rem]/actions:[&>:is(button,a)]:w-auto"
                )}
            >
                {ordered}
            </div>
        </div>
    );
}
