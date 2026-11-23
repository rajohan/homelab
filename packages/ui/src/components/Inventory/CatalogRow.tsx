import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { HeadingLabel } from "../SectionHeader/HeadingLabel";

/** Present one named item in a settings or operations list with its status and independent actions.
 * @returns A responsive list entry whose controls wrap beneath the description on narrow screens.
 */
export function CatalogRow({
    icon,
    title,
    description,
    status,
    actions,
    meta,
    children,
}: {
    readonly icon: LucideIcon;
    readonly title: ReactNode;
    readonly description?: ReactNode;
    readonly status?: ReactNode;
    readonly actions?: ReactNode;
    readonly meta?: ReactNode;
    readonly children?: ReactNode;
}) {
    return (
        <li className="@container/catalog-row min-w-0 py-3 first:pt-0 last:pb-0">
            <div className="grid min-w-0 grid-cols-[1.25rem_minmax(0,1fr)] items-start gap-x-3 gap-y-2 @min-[36rem]/catalog-row:grid-cols-[1.25rem_minmax(0,1fr)_auto]">
                <div className="col-span-2 min-w-0">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <h3 className="min-w-0 text-base font-semibold tracking-tight">
                            <HeadingLabel icon={icon}>{title}</HeadingLabel>
                        </h3>
                        {meta && (
                            <span className="text-xs text-primary-400 tabular-nums">
                                {meta}
                            </span>
                        )}
                        {status}
                    </div>
                    {description && (
                        <p className="mt-1 ps-8 text-sm leading-snug wrap-anywhere text-primary-400">
                            {description}
                        </p>
                    )}
                </div>
                {actions && (
                    <div className="col-start-2 flex min-w-0 flex-wrap items-center gap-2 @min-[36rem]/catalog-row:col-start-3 @min-[36rem]/catalog-row:row-start-1">
                        {actions}
                    </div>
                )}
                {children && (
                    <div className="col-start-2 col-end-[-1] min-w-0 space-y-1 text-sm text-primary-300 empty:hidden">
                        {children}
                    </div>
                )}
            </div>
        </li>
    );
}
