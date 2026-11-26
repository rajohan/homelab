import { ArrowDown, ArrowUp } from "lucide-react";

import type { TableSort } from "./tableSorting";

/**
 * Display an accessible header sorting control matching the dashboard's table style.
 * @returns Header text with an arrow only when this column is sorted.
 */
export function TableSortButton({
    label,
    direction,
    onClick,
}: {
    readonly label: string;
    readonly direction: TableSort["direction"] | undefined;
    readonly onClick: () => void;
}) {
    const SortIcon = direction === "ascending" ? ArrowUp : ArrowDown;
    const next = { ascending: "descending", descending: "off", none: "ascending" }[
        direction ?? "none"
    ];
    return (
        <button
            type="button"
            onClick={onClick}
            title={`Sort ${next}`}
            aria-label={`Sort by ${label}: ${next}`}
            className="inline-flex max-w-full cursor-pointer items-center gap-1 rounded-sm text-left hover:text-primary-50 focus-visible:outline-2 focus-visible:outline-accent-400"
        >
            <span>{label}</span>
            {direction && <SortIcon size={14} aria-hidden="true" className="shrink-0" />}
        </button>
    );
}
