import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../Button/Button";
import { DropdownMenu, type DropdownMenuAction } from "../DropdownMenu/DropdownMenu";
import { HeadingLabel } from "../SectionHeader/HeadingLabel";

/**
 * Present a history entry with a stable status and action menu in narrow containers.
 * @returns A wrapping title and status above the entry's metadata and optional message.
 */
export function HistoryEntry({
    title,
    icon,
    badge,
    actions,
    showSingleActionInline = false,
    children,
}: {
    readonly title: string;
    readonly icon: LucideIcon;
    readonly badge: ReactNode;
    readonly actions: readonly DropdownMenuAction[];
    readonly showSingleActionInline?: boolean;
    readonly children: ReactNode;
}) {
    const direct =
        showSingleActionInline && actions.length === 1 ? actions[0] : undefined;
    const inline = direct?.onSelect ? direct : undefined;
    return (
        <section className="@container/history-entry min-w-0">
            <div className="space-y-2 p-3 @3xl/history-entry:space-y-3 @3xl/history-entry:p-5">
                <header className="gap-x-3 gap-y-1 @max-3xl/history-entry:status-action-grid @3xl/history-entry:flex @3xl/history-entry:items-center">
                    <h3
                        data-slot="title"
                        className="min-w-0 text-base leading-snug font-semibold text-primary-50 @3xl/history-entry:text-xl"
                    >
                        <HeadingLabel icon={icon}>{title}</HeadingLabel>
                    </h3>
                    <div
                        data-slot="status"
                        className="min-w-0 @3xl/history-entry:shrink-0"
                    >
                        {badge}
                    </div>
                    <div
                        data-slot="actions"
                        className="shrink-0 @3xl/history-entry:ms-auto"
                    >
                        <div className={inline ? "@3xl/history-entry:hidden" : undefined}>
                            <DropdownMenu
                                label={`Actions for ${title}`}
                                actions={actions}
                            />
                        </div>
                        {inline && (
                            <Button
                                variant="secondary"
                                className="hidden @3xl/history-entry:inline-flex"
                                disabled={inline.disabled}
                                onClick={inline.onSelect}
                            >
                                {inline.label}
                            </Button>
                        )}
                    </div>
                </header>
                <div className="min-w-0 space-y-1 text-sm wrap-anywhere text-primary-300">
                    {children}
                </div>
            </div>
        </section>
    );
}
