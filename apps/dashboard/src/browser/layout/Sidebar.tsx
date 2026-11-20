import { Brand, IconButton } from "@homelab/ui";
import { Link } from "@tanstack/react-router";
import {
    Archive,
    BellRing,
    Boxes,
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
        ["/applications", "Applications", Boxes],
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
    onClose,
    onNavigate,
    compact = false,
}: {
    readonly compact?: boolean;
    readonly onClose?: (() => void) | undefined;
    readonly onNavigate?: (() => void) | undefined;
}) {
    return (
        <>
            <div
                className={`flex h-18 shrink-0 items-center gap-2 border-b border-primary-700 ${compact ? "justify-center px-2" : "justify-between px-5"}`}
            >
                <Link to="/" aria-label="Homelab overview" onClick={onNavigate}>
                    <Brand compact={compact} />
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
                            <NavigationLink
                                key={to}
                                to={to}
                                label={label}
                                icon={icon}
                                onNavigate={onNavigate}
                                compact={compact}
                            />
                        ))}
                    </div>
                ))}
            </nav>
        </>
    );
}
