import type { ReactNode } from "react";
/**
 * Render a page heading with optional introductory text and an eyebrow label.
 * @returns The component's rendered content for its current state.
 */
export function PageHeader({
    title,
    description,
    eyebrow,
}: {
    title: string;
    description?: ReactNode;
    eyebrow?: string;
}) {
    return (
        <header className="mb-7">
            {eyebrow && (
                <p className="text-xs font-semibold tracking-widest text-primary-400 uppercase">
                    {eyebrow}
                </p>
            )}
            <h1 className="my-2 text-2xl leading-tight font-semibold tracking-tight sm:text-3xl">
                {title}
            </h1>
            {description && (
                <p className="max-w-3xl text-sm leading-6 text-primary-400">
                    {description}
                </p>
            )}
        </header>
    );
}
