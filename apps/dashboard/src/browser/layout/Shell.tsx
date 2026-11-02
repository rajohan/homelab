import { IconButton, type PopoverControl } from "@homelab/ui";
import { Link, Outlet, useLocation } from "@tanstack/react-router";
import { Menu, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useRef, useState } from "react";

import { JobActivity } from "../features/jobs/JobActivity";
import { JobActivityContext } from "../features/jobs/JobActivityContext";
import { NotificationCenter } from "../features/notifications/NotificationCenter";
import { MobileNavigation } from "./MobileNavigation";
import { Sidebar } from "./Sidebar";

/**
 * Render responsive dashboard navigation and the active child route.
 * @returns The component's rendered content for its current state.
 */
export function Shell() {
    const location = useLocation();
    const chatWorkspace =
        location.pathname === "/mira" || location.pathname.startsWith("/mira/");
    const [navigationPath, setNavigationPath] = useState<string>();
    const [compactNavigation, setCompactNavigation] = useState(() => {
        try {
            return localStorage.getItem("homelab.navigation.compact") === "true";
        } catch {
            return false;
        }
    });
    const toggleNavigation = () => {
        const next = !compactNavigation;
        setCompactNavigation(next);
        try {
            localStorage.setItem("homelab.navigation.compact", String(next));
        } catch {
            /* Navigation still works when browser storage is unavailable. */
        }
    };
    const activityControl = useRef<PopoverControl>(null);
    const revealActivity = () => {
        // Let the initiating confirmation close before moving focus to another panel.
        requestAnimationFrame(() => activityControl.current?.open());
    };
    const titles: Readonly<Record<string, string>> = {
        "/mira": "Chat",
        "/tasks": "Tasks",
        "/reports": "Reports",
        "/mira-automations": "Automations",
        "/settings": "Settings",
        "/infrastructure": "Infrastructure",
        "/jobs": "Jobs",
        "/applications": "Applications",
        "/alerts": "Incidents",
        "/backups": "Backups",
        "/updates": "Updates",
        "/identity": "Identity",
    };
    const sectionPath = `/${location.pathname.split("/")[1] ?? ""}`;
    const title = titles[sectionPath] ?? "Overview";
    return (
        <JobActivityContext value={revealActivity}>
            <div
                className={`${chatWorkspace ? "h-dvh overflow-hidden" : "min-h-dvh"} bg-primary-900 text-primary-50`}
            >
                <a
                    className="fixed top-3 left-3 z-50 -translate-y-24 rounded-lg bg-accent-700 px-4 py-3 text-sm font-semibold text-white focus:translate-y-0"
                    href="#main-content"
                >
                    Skip to content
                </a>
                <aside
                    className={`fixed inset-y-0 left-0 hidden flex-col border-r border-primary-700 bg-primary-950 lg:flex ${compactNavigation ? "w-18" : "w-60 xl:w-64"}`}
                >
                    <Sidebar compact={compactNavigation} />
                </aside>
                <MobileNavigation
                    open={navigationPath === location.pathname}
                    onClose={() => setNavigationPath(undefined)}
                />
                <div
                    className={`flex min-w-0 flex-col ${compactNavigation ? "lg:pl-18" : "lg:pl-60 xl:pl-64"} ${chatWorkspace ? "h-full min-h-0" : "min-h-dvh"}`}
                >
                    <header className="sticky top-0 z-20 flex h-20 shrink-0 items-center justify-between gap-3 border-b border-primary-700 bg-primary-950/95 px-4 backdrop-blur-sm sm:px-5">
                        <div className="flex min-w-0 items-center gap-3">
                            <IconButton
                                icon={Menu}
                                label="Open navigation menu"
                                className="lg:hidden"
                                onClick={() => setNavigationPath(location.pathname)}
                            />
                            <IconButton
                                icon={compactNavigation ? PanelLeftOpen : PanelLeftClose}
                                label={
                                    compactNavigation
                                        ? "Expand navigation"
                                        : "Collapse navigation"
                                }
                                className="hidden lg:inline-flex"
                                aria-expanded={!compactNavigation}
                                onClick={toggleNavigation}
                            />
                            <nav
                                aria-label="Breadcrumb"
                                className="min-w-0 text-sm font-medium"
                            >
                                <ol className="flex min-w-0 items-center gap-3">
                                    <li>
                                        <Link
                                            to="/"
                                            className="rounded text-primary-400 hover:text-primary-50 focus-visible:outline-2 focus-visible:outline-accent-300"
                                        >
                                            Homelab
                                        </Link>
                                    </li>
                                    <li aria-hidden="true" className="text-primary-600">
                                        /
                                    </li>
                                    <li className="min-w-0">
                                        <Link
                                            to={title === "Overview" ? "/" : sectionPath}
                                            className="block truncate rounded text-primary-100 hover:text-white focus-visible:outline-2 focus-visible:outline-accent-300"
                                            aria-current="page"
                                        >
                                            {title}
                                        </Link>
                                    </li>
                                </ol>
                            </nav>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                            <JobActivity controlRef={activityControl} />
                            <NotificationCenter />
                        </div>
                    </header>
                    <main
                        className={`mx-auto w-full max-w-400 min-w-0 flex-1 p-4 sm:p-5 ${chatWorkspace ? "flex min-h-0 flex-col overflow-hidden" : ""}`}
                        id="main-content"
                        tabIndex={-1}
                    >
                        <Outlet />
                    </main>
                    {!chatWorkspace && (
                        <footer className="mx-auto w-full max-w-400 px-4 pt-2 pb-5 text-center text-xs text-primary-500 sm:px-5">
                            Homelab Dashboard · Rajohan
                        </footer>
                    )}
                </div>
            </div>
        </JobActivityContext>
    );
}
