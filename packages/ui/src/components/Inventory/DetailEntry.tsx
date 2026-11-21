import type { ReactNode } from "react";

import { cn } from "../../lib/classNames";
import { BreakableName } from "./BreakableName";

/** Pair an inventory identity with its measured values, stacking them when space is limited.
 * @returns One responsive entry inside a detail list.
 */
export function DetailEntry({
    name,
    description,
    accessory,
    wideName = false,
    children,
}: {
    readonly name: ReactNode;
    readonly description?: ReactNode;
    readonly accessory?: ReactNode;
    readonly wideName?: boolean;
    readonly children: ReactNode;
}) {
    return (
        <div
            className={cn(
                "grid min-w-0 items-center gap-x-5 gap-y-2",
                wideName
                    ? "@min-[38rem]/entries:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]"
                    : "@min-[38rem]/entries:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]"
            )}
        >
            <div className="min-w-0">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <div className="min-w-0 text-sm font-semibold wrap-anywhere">
                        <BreakableName>{name}</BreakableName>
                    </div>
                    {accessory}
                </div>
                {description && (
                    <p className="mt-0.5 text-xs leading-relaxed wrap-anywhere text-primary-400">
                        {description}
                    </p>
                )}
            </div>
            <div className="min-w-0 text-sm">{children}</div>
        </div>
    );
}
