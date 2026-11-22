import { Brand, IconButton, type PageOutline } from "@homelab/ui";
import { Link, useLocation } from "@tanstack/react-router";
import {
    Archive,
    BellRing,
    Clock,
    FileText,
    LayoutDashboard,
    ListChecks,
    ListTodo,
    MessageSquare,
    PackageCheck,
    Server,
    Settings,
    X,
} from "lucide-react";

import { NavigationLink } from "./NavigationLink";

const navigationGroups = [
    [
        ["/", "Overview", LayoutDashboard],
        ["/mira", "Chat", MessageSquare],
        ["/tasks", "Tasks", ListTodo],
        ["/reports", "Reports", FileText],
        ["/mira-automations", "Automations", Clock],
    ],
    [
        ["/infrastructure", "Infrastructure", Server],
        ["/jobs", "Jobs", ListChecks],
        ["/alerts", "Incidents", BellRing],
        ["/backups", "Backups", Archive],
        ["/updates", "Updates", PackageCheck],
    ],
    [["/settings", "Settings", Settings]],
] as const;

/**
 * Render shared desktop and mobile navigation with optional close callbacks.
 * @returns The component's rendered content for its current state.
 */
export function Sidebar({
    outline,
    onClose,
    onNavigate,
    compact = false,
}: {
    readonly outline: PageOutline | null;
    readonly compact?: boolean;
    readonly onClose?: (() => void) | undefined;
    readonly onNavigate?: (() => void) | undefined;
}) {
    const path = useLocation({ select: (location) => location.pathname });
    return (
        <>
            <div
                className={`h-shell-header flex shrink-0 items-center gap-2 border-b border-primary-700 ${compact ? "justify-center px-2" : "justify-between px-5"}`}
            >
                <Link
                    to="/"
                    aria-label="Homelab overview"
                    onClick={onNavigate}
                    className="inline-flex min-h-11 min-w-11 items-center justify-center rounded focus-visible:outline-2 focus-visible:outline-accent-300"
                >
                    <Brand compact={compact} size="sm" />
                </Link>
                {onClose && (
                    <IconButton
                        icon={X}
                        label="Close navigation menu"
                        onClick={onClose}
                    />
                )}
            </div>
            <nav
                className="min-h-0 flex-1 divide-y divide-primary-700 overflow-y-auto px-3"
                aria-label="Main navigation"
            >
                {navigationGroups.map((group) => (
                    <div className="grid gap-0.5 py-3" key={group[0][0]}>
                        {group.map(([to, label, icon]) => (
                            <div key={to}>
                                <NavigationLink
                                    to={to}
                                    label={label}
                                    icon={icon}
                                    onNavigate={onNavigate}
                                    compact={compact}
                                />
                                {!compact && path === to && outline?.path === to && (
                                    <ul
                                        aria-label={outline.label}
                                        className="mt-0.5 mb-2 ml-6 grid"
                                    >
                                        {outline.items.map((item) => (
                                            <li key={item.id}>
                                                <a
                                                    href={`#${item.id}`}
                                                    onClick={onNavigate}
                                                    aria-current={
                                                        outline.current === item.id
                                                            ? "location"
                                                            : undefined
                                                    }
                                                    className="flex min-h-11 items-center gap-2 rounded px-2 text-xs leading-snug text-primary-400 hover:bg-primary-800 hover:text-primary-100 focus-visible:outline-2 focus-visible:outline-accent-300 aria-[current=location]:font-semibold aria-[current=location]:text-accent-200 lg:min-h-8"
                                                >
                                                    <span
                                                        aria-hidden="true"
                                                        className={`size-1.5 shrink-0 rounded-full ${outline.current === item.id ? "bg-accent-400" : "bg-transparent"}`}
                                                    />
                                                    {item.label}
                                                </a>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                        ))}
                    </div>
                ))}
            </nav>
        </>
    );
}
