import { MarkdownText } from "@homelab/ui";
import { ChevronRight, type LucideIcon } from "lucide-react";
import { type ReactNode, useState } from "react";

/** Keep the latest event on one line and reveal its complete activity stream on request.
 * @returns An independently expandable work-note or tool section.
 */
export function ChatActivityDisclosure({
    label,
    icon: Icon,
    count,
    summary,
    children,
}: {
    readonly label: string;
    readonly icon: LucideIcon;
    readonly count?: number | undefined;
    readonly summary: string;
    readonly children: ReactNode;
}) {
    const [open, setOpen] = useState(false);
    return (
        <details
            open={open}
            onToggle={(event) => setOpen(event.currentTarget.open)}
            className="group/activity min-w-0"
        >
            <summary
                title={open ? undefined : summary}
                className="flex min-h-8 cursor-pointer list-none items-center gap-2 px-2.5 py-1 text-xs hover:bg-primary-800/60 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent-300 pointer-coarse:min-h-10 [&::-webkit-details-marker]:hidden"
            >
                <Icon
                    size={14}
                    aria-hidden="true"
                    className="shrink-0 text-primary-400"
                />
                <span className="shrink-0 font-medium text-primary-100">{label}</span>
                {count !== undefined && (
                    <span className="shrink-0 text-primary-400 tabular-nums">
                        {count}
                    </span>
                )}
                <span className="min-w-0 flex-1 truncate text-primary-400 group-open/activity:invisible [&_span]:truncate">
                    <MarkdownText>{summary}</MarkdownText>
                </span>
                <ChevronRight
                    size={13}
                    aria-hidden="true"
                    className="shrink-0 text-primary-400 group-open/activity:rotate-90 motion-safe:transition-transform"
                />
            </summary>
            {children}
        </details>
    );
}
