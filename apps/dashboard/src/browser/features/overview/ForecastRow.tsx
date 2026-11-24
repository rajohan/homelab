import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

/** Display current conditions or a daily forecast with temperatures in the same column.
 * @returns One weather list item.
 */
export function ForecastRow({
    title,
    condition: { Icon, label },
    children,
}: {
    readonly title: string;
    readonly condition: { Icon: LucideIcon; label: string };
    readonly children: ReactNode;
}) {
    return (
        <li className="flex items-center gap-3 py-3">
            <Icon size={18} className="shrink-0 text-accent-300" aria-hidden="true" />
            <div className="min-w-0 flex-1">
                <p className="text-sm font-medium">{title}</p>
                <p className="text-xs text-primary-400">{label}</p>
            </div>
            <span className="text-sm whitespace-nowrap tabular-nums">{children}</span>
        </li>
    );
}
