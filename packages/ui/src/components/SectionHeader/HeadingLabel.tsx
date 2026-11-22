import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/classNames";
import { SectionIcon } from "./SectionIcon";

/** Pair a heading icon with the cap height of its label, keeping a full line of space for the row.
 * @returns A wrapping label that uses the typography of the surrounding heading.
 */
export function HeadingLabel({
    icon,
    size = 20,
    className,
    children,
}: {
    readonly icon?: LucideIcon | undefined;
    readonly size?: number;
    readonly className?: string;
    readonly children: ReactNode;
}) {
    return (
        <span className={cn("flex min-h-lh min-w-0 items-center gap-3", className)}>
            {icon && <SectionIcon icon={icon} size={size} />}
            <span className="min-w-0 wrap-anywhere [text-box:trim-both_cap_alphabetic]">
                {children}
            </span>
        </span>
    );
}
