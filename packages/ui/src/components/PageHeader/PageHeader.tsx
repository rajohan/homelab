import { type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { HeadingLabel } from "../SectionHeader/HeadingLabel";

/**
 * Render a page heading with optional introductory text, status and an eyebrow label.
 * @returns The component's rendered content for its current state.
 */
export function PageHeader({
    title,
    icon,
    description,
    eyebrow,
    accessory,
    actions,
    compactActions = false,
}: {
    title: string;
    icon?: LucideIcon;
    description?: ReactNode;
    eyebrow?: string;
    accessory?: ReactNode;
    actions?: ReactNode;
    compactActions?: boolean;
}) {
    return (
        <header
            className={
                compactActions
                    ? "@container/page-header mb-3"
                    : "@container/page-header mb-6"
            }
        >
            <div
                className={
                    compactActions
                        ? "flex flex-wrap items-center justify-between gap-x-3 gap-y-1"
                        : "grid gap-4 @min-[40rem]/page-header:grid-cols-[minmax(16rem,1fr)_minmax(0,auto)] @min-[40rem]/page-header:items-center"
                }
            >
                <div className="min-w-0">
                    {eyebrow && (
                        <p className="text-xs font-semibold tracking-widest text-primary-400 uppercase">
                            {eyebrow}
                        </p>
                    )}
                    <div className="my-2 flex flex-wrap items-center gap-x-3 gap-y-2">
                        <h1 className="min-w-0 text-3xl leading-tight font-semibold tracking-tight sm:text-4xl">
                            <HeadingLabel icon={icon} size={25} className="gap-2.5">
                                {title}
                            </HeadingLabel>
                        </h1>
                        {accessory && (
                            <div className="flex shrink-0 items-center">{accessory}</div>
                        )}
                    </div>
                    {description && (
                        <p className="max-w-3xl text-sm leading-6 text-primary-400">
                            {description}
                        </p>
                    )}
                </div>
                {actions && (
                    <div
                        className={
                            compactActions
                                ? "flex min-w-0 flex-wrap items-center gap-2"
                                : "flex min-w-0 flex-col gap-2 @min-[40rem]/page-header:flex-row @min-[40rem]/page-header:flex-wrap @min-[40rem]/page-header:justify-end [&>a]:w-full @min-[40rem]/page-header:[&>a]:w-auto [&>button]:w-full @min-[40rem]/page-header:[&>button]:w-auto"
                        }
                    >
                        {actions}
                    </div>
                )}
            </div>
        </header>
    );
}
