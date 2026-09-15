import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * Display a section title, supporting text, icon and optional actions.
 * @returns The component's rendered content for its current state.
 */
export function SectionHeader({
    title,
    description,
    icon: Icon,
    actions,
}: {
    readonly title: string;
    readonly description?: string;
    readonly icon: LucideIcon;
    readonly actions?: ReactNode;
}) {
    return (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 flex-1 gap-3">
                <span className="mt-0.5 shrink-0 text-accent-300">
                    <Icon size={19} aria-hidden="true" />
                </span>
                <div className="min-w-0">
                    <h2 className="text-base font-semibold text-primary-50">{title}</h2>
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
