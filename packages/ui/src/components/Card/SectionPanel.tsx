import type { ComponentProps, ReactNode } from "react";

import { cn } from "../../lib/classNames";
import { SectionHeader } from "../SectionHeader/SectionHeader";
import { Card } from "./Card";

/** Group a named section and its controls on one surface. Children supply their own content layout.
 * @param props - The visible heading, optional status or navigation, and the section content.
 * @returns A named region with a shared header, divider and responsive padding.
 */
export function SectionPanel({
    title,
    children,
    className,
    id,
    description,
    compactActions = true,
    ...heading
}: Omit<ComponentProps<typeof SectionHeader>, "title"> & {
    readonly title: string;
    readonly className?: string;
    readonly id?: string;
    readonly children: ReactNode;
}) {
    return (
        <Card
            id={id}
            aria-label={title}
            className={cn("flex flex-col", className)}
            header={
                <>
                    <SectionHeader
                        title={title}
                        {...heading}
                        compactActions={compactActions}
                    />
                    {description && (
                        <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-primary-400">
                            {description}
                        </p>
                    )}
                </>
            }
        >
            <div className="flex min-w-0 flex-1 flex-col gap-3 pt-3">{children}</div>
        </Card>
    );
}
