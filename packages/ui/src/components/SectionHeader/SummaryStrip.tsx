import type { ReactNode } from "react";

/** Present related readings as a responsive definition list with their supplied measurement labels.
 * @returns A compact strip that reflows with the available container width.
 */
export function SummaryStrip({
    items,
}: {
    readonly items: readonly { label: string; value: ReactNode }[];
}) {
    return (
        <dl className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,9rem),1fr))] gap-x-3 gap-y-4 border-b border-primary-700 py-4">
            {items.map((item) => (
                <div
                    key={item.label}
                    className="flex min-w-0 flex-row-reverse flex-wrap items-baseline justify-end gap-x-2 gap-y-0.5 border-l border-primary-700 pl-3"
                >
                    <dt className="text-xs text-primary-400">{item.label}</dt>
                    <dd className="text-xl font-semibold tracking-tight tabular-nums">
                        {item.value}
                    </dd>
                </div>
            ))}
        </dl>
    );
}
