import { Link } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";

/**
 * Render a dashboard navigation link with accessible active-page feedback.
 * @returns The component's rendered content for its current state.
 */
export function NavigationLink({
    to,
    label,
    icon: Icon,
    onNavigate,
}: {
    readonly to: "/" | "/settings" | "/infrastructure" | "/jobs" | "/applications";
    readonly label: string;
    readonly icon: LucideIcon;
    readonly onNavigate?: (() => void) | undefined;
}) {
    return (
        <Link
            to={to}
            onClick={onNavigate}
            activeOptions={{ exact: to === "/" }}
            activeProps={{ "aria-current": "page" }}
            className="flex min-h-11 items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium text-primary-300 transition-colors hover:bg-primary-800 hover:text-primary-50 focus-visible:ring-2 focus-visible:ring-accent-300 focus-visible:outline-none aria-[current=page]:bg-accent-700 aria-[current=page]:text-white motion-reduce:transition-none"
        >
            <Icon size={19} className="shrink-0" aria-hidden="true" />
            {label}
        </Link>
    );
}
