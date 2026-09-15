import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

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
        <div className="flex flex-wrap items-start justify-between gap-4">
            <div className="flex min-w-0 flex-1 gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-lg border border-primary-700 bg-primary-900 text-primary-300">
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
