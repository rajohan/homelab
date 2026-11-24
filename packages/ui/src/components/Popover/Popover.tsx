import {
    Popover as HeadlessPopover,
    PopoverButton,
    PopoverPanel,
} from "@headlessui/react";
import { type ReactNode, type Ref, useImperativeHandle, useRef } from "react";

import { cn } from "../../lib/classNames";
import { buttonStyles } from "../Button/buttonStyles";

export interface PopoverControl {
    /** Open the panel after an explicit user action, without toggling an already open panel. */
    open: () => void;
}

/**
 * Anchor a keyboard-accessible floating panel within the available viewport.
 * @returns A shared icon trigger and lazily mounted, focus-managed panel.
 */
export function Popover({
    label,
    trigger,
    children,
    controlRef,
    anchor = "bottom end",
    panelClassName,
    layout = "default",
    triggerStyle = "icon",
    disabled = false,
}: {
    readonly anchor?: "top start" | "bottom end";
    readonly layout?: "default" | "feed";
    readonly triggerStyle?: "icon" | "label";
    readonly panelClassName?: string;
    readonly disabled?: boolean;
    readonly label: string;
    readonly trigger: ReactNode;
    readonly children: ReactNode | ((controls: { close: () => void }) => ReactNode);
    readonly controlRef?: Ref<PopoverControl> | undefined;
}) {
    const triggerRef = useRef<HTMLButtonElement>(null);
    useImperativeHandle(controlRef, () => ({
        open: () => {
            // Headless UI owns disclosure state; use its public trigger rather than duplicating it.
            if (triggerRef.current?.getAttribute("aria-expanded") === "false")
                triggerRef.current.click();
        },
    }));
    return (
        <HeadlessPopover>
            <PopoverButton
                ref={triggerRef}
                disabled={disabled}
                type="button"
                aria-label={label}
                title={label}
                className={buttonStyles({
                    variant: "ghost",
                    size: triggerStyle === "label" ? "sm" : "md",
                    className:
                        triggerStyle === "icon" ? "relative size-11 p-0" : undefined,
                })}
            >
                {trigger}
            </PopoverButton>
            <PopoverPanel
                anchor={{ to: anchor, gap: 8, padding: 8 }}
                transition
                className={cn(
                    "z-40 flex w-[min(34rem,calc(100vw-1rem))] flex-col overflow-hidden! rounded-xl border border-primary-700 bg-surface-panel p-4 text-primary-50 shadow-2xl shadow-black/50 transition duration-150 data-closed:opacity-0 motion-reduce:transition-none sm:p-5",
                    layout === "feed" && "w-[min(31rem,calc(100vw-1rem))] p-0 sm:p-0",
                    panelClassName
                )}
            >
                {({ close }) => (
                    <>{typeof children === "function" ? children({ close }) : children}</>
                )}
            </PopoverPanel>
        </HeadlessPopover>
    );
}
