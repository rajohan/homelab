import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/classNames";
import { HeadingLabel } from "./HeadingLabel";

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
    readonly title: ReactNode;
    readonly description?: string;
    readonly icon?: LucideIcon;
    readonly actions?: ReactNode;
    readonly badge?: ReactNode;
    readonly compactActions?: boolean;
}) {
    return (
        <div className="@container/section-header min-w-0">
            <div
                className={cn(
                    "flex gap-3",
                    compactActions
                        ? "flex-row flex-wrap items-center justify-between"
                        : "flex-col @min-[34rem]/section-header:flex-row @min-[34rem]/section-header:items-center @min-[34rem]/section-header:justify-between"
                )}
            >
                <div
                    className={cn(
                        "min-w-0 flex-1",
                        compactActions && actions && "min-w-[min(100%,10rem)]"
                    )}
                >
                    <div className="flex flex-wrap items-center gap-2">
                        <h2 className="min-w-0 text-xl leading-snug font-semibold tracking-tight text-primary-50">
                            <HeadingLabel icon={Icon}>{title}</HeadingLabel>
                        </h2>
                        {badge}
                    </div>
                    {description && (
                        <p
                            className={cn(
                                "mt-1 max-w-2xl text-sm leading-6 text-primary-400",
                                Icon && "ps-8"
                            )}
                        >
                            {description}
                        </p>
                    )}
                </div>
                {actions && (
                    <div
                        className={cn(
                            "has-[[data-ui=action-group]]:w-full @min-[34rem]/section-header:has-[[data-ui=action-group]]:w-80",
                            compactActions
                                ? "max-w-full min-w-0"
                                : "min-w-0 @min-[34rem]/section-header:shrink-0 [&>a]:w-full @min-[34rem]/section-header:[&>a]:w-auto [&>button]:w-full @min-[34rem]/section-header:[&>button]:w-auto"
                        )}
                    >
                        {actions}
                    </div>
                )}
            </div>
        </div>
    );
}
