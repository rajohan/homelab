import { BellRing, type LucideIcon } from "lucide-react";

import { cn } from "../../lib/classNames";

/**
 * Render the shared decorative icon for dashboard headings.
 * @param props - The icon and its size in CSS pixels.
 * @returns A consistently sized accent icon, hidden from assistive technology.
 */
export function SectionIcon({
    icon: Icon,
    size = 20,
    className,
}: {
    readonly size?: number;
    readonly icon: LucideIcon;
    readonly className?: string;
}) {
    return (
        <Icon
            size={size}
            aria-hidden="true"
            className={cn(
                "block shrink-0 text-accent-300",
                // The ringing strokes concentrate the bell's visual weight above its center.
                Icon === BellRing && "translate-y-[10%]",
                className
            )}
        />
    );
}
