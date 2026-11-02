import { Children, useEffect, useState, type ReactNode } from "react";

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
    const [wide, setWide] = useState(false);
    const [element, setElement] = useState<HTMLDivElement | null>(null);
    useEffect(() => {
        if (!element) return;
        const observer = new ResizeObserver(([entry]) => {
            if (!entry) return;
            const rem =
                Number(
                    getComputedStyle(document.documentElement).fontSize.replace("px", "")
                ) || 16;
            setWide(entry.contentRect.width >= (stretch ? 30 : 40) * rem);
        });
        observer.observe(element);
        return () => observer.disconnect();
    }, [element, stretch]);
    const actions = Children.toArray(children);
    const ordered =
        wide && actions.length > 1 ? [...actions.slice(1), actions[0]] : actions;
    return (
        <div ref={setElement} className={cn("min-w-0", className)}>
            <div
                className={cn(
                    "flex justify-end gap-2 [&>:is(button,a)]:max-w-full [&>:is(button,a)]:min-w-0 [&>:is(button,a)]:wrap-anywhere [&>:is(button,a)]:whitespace-normal",
                    wide
                        ? "flex-row flex-wrap [&>:is(button,a)]:w-auto"
                        : "flex-col [&>:is(button,a)]:w-full",
                    wide &&
                        stretch &&
                        "[&>:is(button,a)]:flex-1 [&>:is(button,a):last-child]:flex-2"
                )}
            >
                {ordered}
            </div>
        </div>
    );
}
