import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from "@headlessui/react";
import type { ReactNode } from "react";

import { Button } from "../Button/Button";

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
            <DialogBackdrop className="fixed inset-0 bg-slate-950/40 backdrop-blur-xs" />
            <div className="fixed inset-0 overflow-y-auto p-4 sm:p-8">
                <div className="flex min-h-full items-center justify-center">
                    <DialogPanel className="w-full max-w-lg rounded-xl bg-white p-6 text-base text-slate-900 shadow-xl">
                        <div className="mb-5 flex items-center justify-between gap-4">
                            <DialogTitle className="text-xl font-semibold">
                                {title}
                            </DialogTitle>
                            <Button onClick={onClose} aria-label="Close dialog">
                                Close
                            </Button>
                        </div>
                        {children}
                    </DialogPanel>
                </div>
            </div>
        </Dialog>
    );
}
