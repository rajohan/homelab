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
            <div className="fixed inset-0 overflow-y-auto p-4 sm:p-8">
                <div className="flex min-h-full items-center justify-center">
                    <DialogPanel
                        transition
                        className={cn(
                            "w-full min-w-0 rounded-xl border border-primary-700 bg-primary-800 text-primary-50 shadow-2xl shadow-black/50 transition duration-200 data-closed:translate-y-2 data-closed:opacity-0 motion-reduce:transition-none",
                            size === "wide" ? "max-w-5xl" : "max-w-lg"
                        )}
                    >
                        <div className="flex items-start justify-between gap-3 rounded-t-xl border-b border-primary-700 bg-primary-900/40 px-5 py-4">
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
                        <div className="min-w-0 p-5">{children}</div>
                    </DialogPanel>
                </div>
            </div>
        </Dialog>
    );
}
