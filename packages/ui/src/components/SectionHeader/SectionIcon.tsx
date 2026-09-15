import type { LucideIcon } from "lucide-react";

import { cn } from "../../lib/classNames";

/**
 * Render the shared, unboxed icon used to identify dashboard settings sections.
 * @param props - The section's icon and any alignment adjustment.
 * @returns A consistently sized accent icon, hidden from assistive technology.
 */
export function SectionIcon({
    icon: Icon,
    className,
}: {
    readonly icon: LucideIcon;
    readonly className?: string;
}) {
    return (
        <span className={cn("shrink-0 text-accent-300", className)}>
            <Icon size={19} aria-hidden="true" />
        </span>
    );
}
