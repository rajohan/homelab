import {
    Description,
    Dialog,
    DialogBackdrop,
    DialogPanel,
    DialogTitle,
} from "@headlessui/react";
import { type LucideIcon, X } from "lucide-react";
import type { ReactNode, Ref } from "react";

import { cn } from "../../lib/classNames";
import { IconButton } from "../Button/IconButton";
import { BreakableName } from "../Inventory/BreakableName";

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
    keepTitleAccessoryInline = false,
    navigation,
    contentRef,
    icon: Icon,
    footer,
    dismissible = true,
    size = "md",
}: {
    title: string;
    children: ReactNode;
    onClose: () => void;
    description?: string;
    titleAccessory?: ReactNode;
    keepTitleAccessoryInline?: boolean;
    navigation?: ReactNode;
    contentRef?: Ref<HTMLElement>;
    icon?: LucideIcon | undefined;
    footer?: ReactNode;
    dismissible?: boolean;
    size?: "md" | "wide" | "screen";
}) {
    return (
        <Dialog
            open
            onClose={() => {
                if (dismissible) onClose();
            }}
            className="relative z-50 outline-none"
        >
            <DialogBackdrop
                transition
                className="fixed inset-0 bg-black/65 transition duration-200 data-closed:opacity-0 motion-reduce:transition-none"
            />
            <div className="fixed inset-[env(safe-area-inset-top)_env(safe-area-inset-right)_env(safe-area-inset-bottom)_env(safe-area-inset-left)] p-3 sm:p-5 lg:p-8">
                <div className="flex h-full min-h-0 items-center justify-center">
                    <DialogPanel
                        transition
                        className={cn(
                            "flex max-h-full w-full min-w-0 flex-col overflow-hidden rounded-xl border border-primary-700 bg-surface-panel text-primary-50 shadow-xl shadow-black/40 transition duration-150 data-closed:translate-y-2 data-closed:opacity-0 motion-reduce:transition-none",
                            { screen: "max-w-none", wide: "max-w-5xl", md: "max-w-lg" }[
                                size
                            ]
                        )}
                    >
                        <div className="flex max-h-[44dvh] shrink-0 flex-wrap items-start gap-3 overflow-y-auto border-b border-primary-700 bg-surface-heading px-4 py-3 sm:px-6 sm:py-4">
                            {Icon && (
                                <span className="mt-0.5 grid size-10 shrink-0 place-items-center rounded-lg bg-surface-panel text-accent-300">
                                    <Icon size={21} aria-hidden="true" />
                                </span>
                            )}
                            <div className="min-w-0 flex-1 self-center">
                                <div
                                    className={
                                        keepTitleAccessoryInline
                                            ? "flex items-start gap-x-3"
                                            : "flex flex-wrap items-center gap-x-3 gap-y-2"
                                    }
                                >
                                    <DialogTitle className="min-w-0 text-xl leading-tight font-semibold tracking-tight wrap-anywhere">
                                        <BreakableName>{title}</BreakableName>
                                    </DialogTitle>
                                    {titleAccessory && (
                                        <div className="flex max-w-full flex-wrap items-center gap-1.5">
                                            {titleAccessory}
                                        </div>
                                    )}
                                </div>
                                {description && (
                                    <Description className="mt-1 text-sm leading-6 wrap-anywhere text-primary-400">
                                        {description}
                                    </Description>
                                )}
                            </div>
                            {navigation && (
                                <div className="order-last w-full sm:order-0 sm:w-auto sm:self-center">
                                    {navigation}
                                </div>
                            )}
                            {dismissible && (
                                <IconButton
                                    icon={X}
                                    label="Close dialog"
                                    onClick={onClose}
                                    className="-mr-1 self-start"
                                />
                            )}
                        </div>
                        <section
                            ref={contentRef}
                            data-ui="overlay-body"
                            aria-label={`${title} content`}
                            tabIndex={0}
                            className="min-h-0 min-w-0 overflow-y-auto overscroll-contain bg-surface-panel p-4 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-500 has-[>form:empty]:hidden sm:px-6 sm:py-5"
                        >
                            {children}
                        </section>
                        {footer && (
                            <footer className="shrink-0 border-t border-primary-700 bg-surface-panel px-4 py-3 sm:px-6">
                                {footer}
                            </footer>
                        )}
                    </DialogPanel>
                </div>
            </div>
        </Dialog>
    );
}
