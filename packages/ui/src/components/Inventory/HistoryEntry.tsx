import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "../Button/Button";
import { DropdownMenu, type DropdownMenuAction } from "../DropdownMenu/DropdownMenu";
import { SectionIcon } from "../SectionHeader/SectionIcon";

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
                <header className="@max-3xl/history-entry:status-action-grid @3xl/history-entry:flex @3xl/history-entry:items-center @3xl/history-entry:gap-3">
                    <h3
                        data-slot="title"
                        className="flex min-w-0 items-center gap-3 text-sm leading-5 font-semibold text-primary-100 @3xl/history-entry:text-xl @3xl/history-entry:text-primary-50"
                    >
                        <SectionIcon
                            icon={icon}
                            className="hidden @3xl/history-entry:block"
                        />
                        <span className="min-w-0 wrap-anywhere @3xl/history-entry:[text-box:trim-both_cap_alphabetic]">
                            {title}
                        </span>
                    </h3>
                    <div
                        data-slot="status"
                        className="flex min-w-0 capitalize @3xl/history-entry:shrink-0"
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
                <div className="min-w-0 space-y-1 text-xs leading-4 wrap-anywhere text-primary-400 @3xl/history-entry:text-sm @3xl/history-entry:text-primary-300">
                    {children}
                </div>
            </div>
        </section>
    );
}
