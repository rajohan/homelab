import {
    Description,
    Dialog,
    DialogBackdrop,
    DialogPanel,
    DialogTitle,
} from "@headlessui/react";
import { X } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/classNames";
import { IconButton } from "../Button/IconButton";

/**
 * Present a dismissible, focus-managed dialog with a shared title and close control.
 * @returns The component's rendered content for its current state.
 */
export function Modal({
    title,
    children,
    onClose,
    description,
    titleAccessory,
    dismissible = true,
    size = "md",
}: {
    title: string;
    children: ReactNode;
    onClose: () => void;
    description?: string;
    titleAccessory?: ReactNode;
    dismissible?: boolean;
    size?: "md" | "wide";
}) {
    return (
        <Dialog
            open
            onClose={() => {
                if (dismissible) onClose();
            }}
            className="relative z-50"
        >
            <DialogBackdrop
                transition
                className="fixed inset-0 bg-black/65 backdrop-blur-sm transition duration-200 data-closed:opacity-0 motion-reduce:transition-none"
            />
            <div className="fixed inset-0 p-4 sm:p-8">
                <div className="flex h-full min-h-0 items-center justify-center">
                    <DialogPanel
                        transition
                        className={cn(
                            "flex max-h-[calc(100dvh-2rem)] w-full min-w-0 flex-col overflow-hidden rounded-xl border border-primary-700 bg-primary-800 text-primary-50 shadow-2xl shadow-black/50 transition duration-200 data-closed:translate-y-2 data-closed:opacity-0 motion-reduce:transition-none sm:max-h-[calc(100dvh-4rem)]",
                            size === "wide" ? "max-w-5xl" : "max-w-lg"
                        )}
                    >
                        <div className="flex shrink-0 items-start justify-between gap-3 rounded-t-xl border-b border-primary-700 bg-primary-900/40 px-5 py-4">
                            <div className="min-w-0 flex-1">
                                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                                    <DialogTitle className="text-lg font-semibold wrap-anywhere">
                                        {title}
                                    </DialogTitle>
                                    {titleAccessory && (
                                        <div className="shrink-0">{titleAccessory}</div>
                                    )}
                                </div>
                                {description && (
                                    <Description className="mt-1 text-sm leading-6 wrap-anywhere text-primary-400">
                                        {description}
                                    </Description>
                                )}
                            </div>
                            {dismissible && (
                                <IconButton
                                    icon={X}
                                    label="Close dialog"
                                    onClick={onClose}
                                    className="-mt-2 -mr-2"
                                />
                            )}
                        </div>
                        <section
                            aria-label={`${title} content`}
                            tabIndex={0}
                            className="min-h-0 min-w-0 overflow-y-auto overscroll-contain p-5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500"
                        >
                            {children}
                        </section>
                    </DialogPanel>
                </div>
            </div>
        </Dialog>
    );
}
