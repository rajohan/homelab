import { Dialog, DialogBackdrop, DialogPanel, DialogTitle } from "@headlessui/react";
import type { PageOutline } from "@homelab/ui";

import { Sidebar } from "./Sidebar";

/**
 * Display the dashboard navigation in a dismissible, focus-managed mobile drawer.
 * @returns The component's rendered content for its current state.
 */
export function MobileNavigation({
    open,
    outline,
    onClose,
}: {
    readonly outline: PageOutline | null;
    readonly open: boolean;
    readonly onClose: () => void;
}) {
    return (
        <Dialog
            open={open}
            onClose={onClose}
            className="relative z-40 outline-none lg:hidden"
        >
            <DialogBackdrop
                transition
                className="fixed inset-0 bg-black/65 backdrop-blur-sm transition data-closed:opacity-0 motion-reduce:transition-none"
            />
            <div className="fixed inset-0 flex">
                <DialogPanel
                    transition
                    className="flex w-72 max-w-[90vw] flex-col border-r border-primary-700 bg-primary-950 shadow-2xl transition duration-200 data-closed:-translate-x-full motion-reduce:transition-none"
                >
                    <DialogTitle className="sr-only">Homelab navigation</DialogTitle>
                    <Sidebar outline={outline} onClose={onClose} onNavigate={onClose} />
                </DialogPanel>
            </div>
        </Dialog>
    );
}
