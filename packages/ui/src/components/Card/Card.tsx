import type { ComponentProps, ReactElement } from "react";

import { cn } from "../../lib/classNames";

/**
 * Render a shared surface with an optional header and evenly spaced divider.
 * @returns The component's rendered content for its current state.
 */
export function Card({
    className,
    header,
    children,
    ...props
}: ComponentProps<"section"> & { readonly header?: ReactElement }) {
    return (
        <section
            data-ui="card"
            className={cn(
                "max-w-full min-w-0 rounded-xl border border-primary-700 bg-surface-card",
                header ? "px-3 pb-3 sm:px-5 sm:pb-5" : "p-4 sm:p-5",
                className
            )}
            {...props}
        >
            {header && (
                <header className="border-b border-primary-700 py-3 sm:py-4">
                    {header}
                </header>
            )}
            {children}
        </section>
    );
}
