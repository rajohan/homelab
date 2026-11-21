import { type LucideIcon } from "lucide-react";
import { type ReactNode, useId } from "react";

import { Card } from "../Card/Card";
import { HeadingLabel } from "../SectionHeader/HeadingLabel";

/** Give a section in a continuous detail view a heading and space for its own controls.
 * @returns A labelled region with an optional record count and description.
 */
export function DetailSection({
    title,
    icon,
    count,
    anchor,
    description,
    actions,
    children,
}: {
    readonly icon?: LucideIcon | undefined;
    readonly title: string;
    readonly anchor?: string | undefined;
    readonly count?: number;
    readonly description?: string | undefined;
    readonly actions?: ReactNode;
    readonly children: ReactNode;
}) {
    const generatedId = useId();
    const id = anchor ?? generatedId;
    return (
        <Card
            aria-labelledby={id}
            className="space-y-3"
            header={
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                    <h3
                        id={id}
                        tabIndex={anchor ? -1 : undefined}
                        className="flex scroll-mt-4 items-center gap-2 text-lg font-semibold tracking-tight"
                    >
                        <HeadingLabel icon={icon} className="gap-2">
                            {title}
                        </HeadingLabel>
                        {count !== undefined && (
                            <span className="text-xs font-normal text-primary-400 tabular-nums">
                                {count}
                            </span>
                        )}
                    </h3>
                    {actions}
                </div>
            }
        >
            {description && (
                <p className="text-xs leading-relaxed text-primary-400">{description}</p>
            )}
            {children}
        </Card>
    );
}
