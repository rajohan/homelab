import { SlidersHorizontal } from "lucide-react";
import { type ReactNode, useId, useState } from "react";

import { Button } from "../Button/Button";

/**
 * Pair a search field with scope controls. A collapsible filter group keeps the
 * active selection count visible while its individual fields are out of view.
 * @returns A responsive search toolbar that retains filter state across disclosure.
 */
export function FilterBar({
    search,
    children,
    activeFilters,
}: {
    readonly search: ReactNode;
    readonly children: ReactNode;
    readonly activeFilters?: number;
}) {
    const [expanded, setExpanded] = useState(false);
    const id = useId();
    return (
        <div className="@container/filters min-w-0">
            {activeFilters === undefined ? (
                <div className="grid items-center gap-2 @min-[30rem]/filters:grid-cols-[minmax(0,1fr)_minmax(9rem,13rem)]">
                    {search}
                    {children}
                </div>
            ) : (
                <>
                    <div className="flex items-center gap-2">
                        <div className="min-w-0 flex-1">{search}</div>
                        <Button
                            variant="secondary"
                            size="field"
                            aria-expanded={expanded}
                            aria-controls={id}
                            onClick={() => setExpanded(!expanded)}
                        >
                            <SlidersHorizontal size={16} aria-hidden="true" /> Filters
                            {activeFilters > 0 && ` (${activeFilters})`}
                        </Button>
                    </div>
                    <div
                        id={id}
                        hidden={!expanded}
                        className="mt-3 space-y-4 rounded-lg border border-primary-700 bg-surface-card p-4"
                    >
                        {children}
                    </div>
                </>
            )}
        </div>
    );
}
