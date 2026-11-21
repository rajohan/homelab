import type { ReactNode } from "react";

/** Display named readings in a compact definition list that flows with the available width.
 * @returns Values and their optional measurement context.
 */
export function DetailFacts({
    items,
    inline = false,
}: {
    readonly inline?: boolean;
    readonly items: readonly { label: string; value: ReactNode; detail?: string }[];
}) {
    return (
        <dl
            className={
                inline
                    ? "flex flex-wrap items-baseline gap-x-4 gap-y-1"
                    : "grid grid-cols-[repeat(auto-fit,minmax(min(100%,8rem),1fr))] gap-x-5 gap-y-3"
            }
        >
            {items.map(({ label, value, detail }) => (
                <div
                    key={label}
                    className={
                        inline
                            ? "flex min-w-0 flex-wrap items-baseline gap-x-1.5"
                            : "min-w-0"
                    }
                >
                    <dt className="text-xs font-medium text-primary-400">{label}</dt>
                    <dd className="mt-0.5 text-sm font-medium wrap-anywhere text-primary-100 tabular-nums">
                        {value}
                    </dd>
                    {detail && (
                        <dd className="mt-0.5 text-xs leading-relaxed text-primary-400">
                            {detail}
                        </dd>
                    )}
                </div>
            ))}
        </dl>
    );
}
