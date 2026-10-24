import type { ReactNode } from "react";
/**
 * Render a page heading with optional introductory text, status and an eyebrow label.
 * @returns The component's rendered content for its current state.
 */
export function PageHeader({
    title,
    description,
    eyebrow,
    accessory,
    actions,
}: {
    title: string;
    description?: ReactNode;
    eyebrow?: string;
    accessory?: ReactNode;
    actions?: ReactNode;
}) {
    return (
        <header className="@container/page-header mb-7">
            <div className="grid gap-4 @min-[40rem]/page-header:grid-cols-[minmax(0,1fr)_auto] @min-[40rem]/page-header:items-center">
                <div>
                    {eyebrow && (
                        <p className="text-xs font-semibold tracking-widest text-primary-400 uppercase">
                            {eyebrow}
                        </p>
                    )}
                    <div className="my-2 flex flex-wrap items-center gap-x-3 gap-y-2">
                        <h1 className="text-2xl leading-tight font-semibold tracking-tight sm:text-3xl">
                            {title}
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
                    <div className="flex flex-col gap-2 @min-[40rem]/page-header:flex-row [&>button]:w-full @min-[40rem]/page-header:[&>button]:w-auto">
                        {actions}
                    </div>
                )}
            </div>
        </header>
    );
}
