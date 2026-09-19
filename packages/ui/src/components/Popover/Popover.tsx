import {
    Popover as HeadlessPopover,
    PopoverButton,
    PopoverPanel,
} from "@headlessui/react";
import { useImperativeHandle, useRef, type ReactNode, type Ref } from "react";

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
}: {
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
                aria-label={label}
                title={label}
                className={buttonStyles({
                    variant: "ghost",
                    className: "relative size-11 p-0",
                })}
            >
                {trigger}
            </PopoverButton>
            <PopoverPanel
                anchor={{ to: "bottom end", gap: 8, padding: 8 }}
                transition
                className="z-40 flex w-[min(34rem,calc(100vw-1rem))] flex-col overflow-hidden! rounded-xl border border-primary-700 bg-primary-800 p-4 text-primary-50 shadow-2xl shadow-black/50 transition duration-150 data-closed:opacity-0 motion-reduce:transition-none sm:p-5"
            >
                {({ close }) => (
                    <>{typeof children === "function" ? children({ close }) : children}</>
                )}
            </PopoverPanel>
        </HeadlessPopover>
    );
}
