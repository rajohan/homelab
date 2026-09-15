import type { ReactNode } from "react";

import { cn } from "../../lib/classNames";

/**
 * Keep related actions together, with full-width buttons when space requires stacking.
 * @param props - Action buttons and optional spacing around their shared container.
 * @returns A responsive action row that puts the primary, final action first on narrow screens.
 */
export function ActionGroup({
    children,
    className,
}: {
    readonly children: ReactNode;
    readonly className?: string;
}) {
    return (
        <div className={cn("@container", className)}>
            <div className="flex flex-col gap-2 @sm:flex-row @sm:justify-end [&>button]:w-full @sm:[&>button]:w-auto [&>button:only-child]:w-full">
                {children}
            </div>
        </div>
    );
}
