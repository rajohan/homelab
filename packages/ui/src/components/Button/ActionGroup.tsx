import type { ReactNode } from "react";

/**
 * Keep related actions together, with full-width buttons when space requires stacking.
 * @param props - Action buttons and optional spacing around their shared container.
 * @returns A wrapping action row; callers put the primary action first in keyboard and visual order.
 */
export function ActionGroup({
    children,
    className,
}: {
    readonly children: ReactNode;
    readonly className?: string;
}) {
    return (
        <div className={className}>
            <div className="flex flex-col justify-end gap-2 min-[30rem]:flex-row min-[30rem]:flex-wrap [&>button]:w-full [&>button]:max-w-full [&>button]:min-w-0 min-[30rem]:[&>button]:w-auto min-[30rem]:[&>button]:flex-auto">
                {children}
            </div>
        </div>
    );
}
