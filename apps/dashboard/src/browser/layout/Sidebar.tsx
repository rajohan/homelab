import { Brand, IconButton } from "@homelab/ui";
import { Link } from "@tanstack/react-router";
import { LayoutDashboard, Server, Settings, X } from "lucide-react";

import { NavigationLink } from "./NavigationLink";

/**
 * Render shared desktop and mobile navigation with optional close callbacks.
 * @returns The component's rendered content for its current state.
 */
export function Sidebar({
    onClose,
    onNavigate,
}: {
    readonly onClose?: (() => void) | undefined;
    readonly onNavigate?: (() => void) | undefined;
}) {
    return (
        <>
            <div className="flex h-20 shrink-0 items-center justify-between gap-2 border-b border-primary-700 px-5">
                <Link to="/" aria-label="Homelab overview" onClick={onNavigate}>
                    <Brand />
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
                className="min-h-0 flex-1 space-y-1 overflow-y-auto p-3"
                aria-label="Main navigation"
            >
                <p className="px-3 pt-4 pb-3 text-xs font-semibold tracking-widest text-primary-500 uppercase">
                    Workspace
                </p>
                <NavigationLink
                    to="/"
                    label="Overview"
                    icon={LayoutDashboard}
                    onNavigate={onNavigate}
                />
                <NavigationLink
                    to="/infrastructure"
                    label="Infrastructure"
                    icon={Server}
                    onNavigate={onNavigate}
                />
                <NavigationLink
                    to="/settings"
                    label="Settings"
                    icon={Settings}
                    onNavigate={onNavigate}
                />
            </nav>
            <div className="shrink-0 border-t border-primary-700 p-5">
                <p className="text-xs font-medium text-primary-300">
                    Homelab · Identity preview
                </p>
                <p className="mt-2 text-xs leading-5 text-primary-500">
                    Production access is still managed by Authelia.
                </p>
            </div>
        </>
    );
}
