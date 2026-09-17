import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/classNames";
import { SectionIcon } from "./SectionIcon";

/**
 * Display a section title, supporting text, icon and optional actions.
 * @returns The component's rendered content for its current state.
 */
export function SectionHeader({
    title,
    description,
    icon: Icon,
    actions,
    badge,
    compactActions = false,
}: {
    readonly title: string;
    readonly description?: string;
    readonly icon: LucideIcon;
    readonly actions?: ReactNode;
    readonly badge?: ReactNode;
    readonly compactActions?: boolean;
}) {
    return (
        <div
            className={cn(
                "flex gap-3",
                compactActions
                    ? "flex-row items-start justify-between"
                    : "flex-col min-[30rem]:flex-row min-[30rem]:items-center min-[30rem]:justify-between"
            )}
        >
            <div className="flex min-w-0 flex-1 gap-3">
                <SectionIcon icon={Icon} className="mt-0.5" />
                <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                        <h2 className="text-base font-semibold text-primary-50">
                            {title}
                        </h2>
                        {badge}
                    </div>
                    {description && (
                        <p className="mt-1 max-w-2xl text-sm leading-6 text-primary-400">
                            {description}
                        </p>
                    )}
                </div>
            </div>
            {actions}
        </div>
    );
}
