import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/classNames";

/**
 * Explain an empty result or workspace with an optional recovery action.
 * @param props - A standalone message or a titled state with supporting content.
 * @returns A readable inline message with a decorative icon and labelled content.
 */
export function EmptyState(
    props:
        | { readonly message: string }
        | {
              readonly icon: LucideIcon;
              readonly title: string;
              readonly description?: string;
              readonly action?: ReactNode;
              readonly compact?: boolean;
          }
) {
    if ("message" in props) {
        return (
            <p className="rounded-lg border border-primary-700 bg-surface-empty p-4 text-sm text-primary-400">
                {props.message}
            </p>
        );
    }
    const { icon: Icon, title, description, action, compact = false } = props;
    return (
        <div
            className={cn(
                "flex min-w-0 items-start rounded-lg border border-primary-700 bg-surface-empty",
                compact ? "gap-3 p-3" : "gap-4 px-4 py-6 sm:p-6"
            )}
        >
            <Icon
                className="mt-0.5 shrink-0 text-accent-300"
                size={compact ? 18 : 22}
                aria-hidden="true"
            />
            <div className="min-w-0 space-y-1">
                <p className="font-semibold text-primary-100">{title}</p>
                {description && (
                    <p className="max-w-prose text-sm leading-6 text-primary-400">
                        {description}
                    </p>
                )}
                {action && <div className="pt-2">{action}</div>}
            </div>
        </div>
    );
}
