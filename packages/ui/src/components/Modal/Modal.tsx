import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from "@headlessui/react";
import { X } from "lucide-react";
import type { ReactNode } from "react";

import { IconButton } from "../Button/IconButton";

export function Modal({
    title,
    children,
    onClose,
}: {
    title: string;
    children: ReactNode;
    onClose: () => void;
}) {
    return (
        <Dialog open onClose={onClose} className="relative z-50">
            <DialogBackdrop
                transition
                className="fixed inset-0 bg-black/65 backdrop-blur-sm transition duration-200 data-closed:opacity-0 motion-reduce:transition-none"
            />
            <div className="fixed inset-0 overflow-y-auto p-4 sm:p-8">
                <div className="flex min-h-full items-center justify-center">
                    <DialogPanel
                        transition
                        className="w-full max-w-lg min-w-0 rounded-xl border border-primary-700 bg-primary-800 text-primary-50 shadow-2xl shadow-black/50 transition duration-200 data-closed:translate-y-2 data-closed:opacity-0 motion-reduce:transition-none"
                    >
                        <div className="flex items-start justify-between gap-3 rounded-t-xl border-b border-primary-700 bg-primary-900/40 px-5 py-4">
                            <DialogTitle className="min-w-0 pt-2 text-lg font-semibold wrap-anywhere">
                                {title}
                            </DialogTitle>
                            <IconButton
                                icon={X}
                                label="Close dialog"
                                onClick={onClose}
                                className="-mr-2"
                            />
                        </div>
                        <div className="min-w-0 p-5">{children}</div>
                    </DialogPanel>
                </div>
            </div>
        </Dialog>
    );
}
