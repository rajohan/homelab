import { Button as HeadlessButton } from "@headlessui/react";
import { LoaderCircle } from "lucide-react";
import type { ComponentProps } from "react";

import { LoadingDots } from "../Loading/LoadingDots";
import { buttonStyles, type ButtonSize, type ButtonVariant } from "./buttonStyles";

export function Button({
    className,
    disabled = false,
    ref = null,
    type = "button",
    children,
    busy = false,
    busyLabel = "Please wait…",
    fullWidth = false,
    variant = "primary",
    size = "md",
    ...props
}: Omit<ComponentProps<"button">, "autoFocus"> & {
    readonly busy?: boolean;
    readonly busyLabel?: string;
    readonly fullWidth?: boolean;
    readonly variant?: ButtonVariant;
    readonly size?: ButtonSize;
}) {
    return (
        <HeadlessButton
            {...props}
            disabled={disabled || busy}
            ref={ref}
            type={type}
            aria-busy={busy || props["aria-busy"] || undefined}
            aria-label={props["aria-label"] ?? (busy ? busyLabel : undefined)}
            className={buttonStyles({ className, variant, size, fullWidth })}
        >
            {busy && (
                <LoaderCircle
                    aria-hidden="true"
                    size={16}
                    className="shrink-0 animate-spin motion-reduce:animate-none"
                />
            )}
            {busy ? <LoadingDots label={busyLabel} /> : children}
        </HeadlessButton>
    );
}
