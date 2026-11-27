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
                "max-w-full min-w-0 rounded-xl border border-primary-700 bg-surface-card px-4 sm:px-5",
                header ? "pb-3 sm:pb-5" : "py-4 sm:py-5",
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
