import { type LucideIcon, X } from "lucide-react";
import type { ReactNode } from "react";

import { IconButton } from "../Button/IconButton";

/** Give the header activity feeds the same title, dismissal control and bounded content area.
 * @param props - The feed identity, a live summary and its filters or activity rows.
 * @returns A labelled, scrollable panel that keeps all controls reachable on short screens.
 */
export function ActivityPanel({
    title,
    icon: Icon,
    summary,
    onClose,
    children,
}: {
    readonly title: string;
    readonly icon: LucideIcon;
    readonly summary?: ReactNode;
    readonly onClose: () => void;
    readonly children: ReactNode;
}) {
    return (
        <section
            aria-label={title}
            className="flex min-h-0 flex-col overflow-y-auto overscroll-contain"
        >
            <header className="flex shrink-0 items-center gap-3 border-b border-primary-700 bg-surface-heading px-4 py-3 sm:px-5">
                <Icon aria-hidden="true" size={21} className="shrink-0 text-accent-300" />
                <div className="min-w-0 flex-1">
                    <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
                    {summary && (
                        <p className="mt-0.5 text-xs text-primary-300">{summary}</p>
                    )}
                </div>
                <IconButton
                    icon={X}
                    label={`Close ${title.toLowerCase()}`}
                    onClick={onClose}
                />
            </header>
            <div
                data-ui="overlay-body"
                className="flex min-w-0 flex-col gap-3 bg-surface-panel p-3 sm:p-4"
            >
                {children}
            </div>
        </section>
    );
}
