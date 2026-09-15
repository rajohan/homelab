import type { LucideIcon } from "lucide-react";
import type { ComponentProps } from "react";

import { cn } from "../../lib/classNames";
import { Button } from "./Button";

export function IconButton({
    icon: Icon,
    label,
    className,
    ...props
}: Omit<ComponentProps<typeof Button>, "children" | "aria-label"> & {
    readonly icon: LucideIcon;
    readonly label: string;
}) {
    return (
        <Button
            variant="ghost"
            {...props}
            aria-label={label}
            title={label}
            className={cn("size-11 shrink-0 p-0", className)}
        >
            <Icon size={20} aria-hidden="true" />
        </Button>
    );
}
