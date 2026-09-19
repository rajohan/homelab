import { IconButton, type PopoverControl } from "@homelab/ui";
import { Outlet, useLocation } from "@tanstack/react-router";
import { Menu } from "lucide-react";
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
    const [navigationPath, setNavigationPath] = useState<string>();
    const activityControl = useRef<PopoverControl>(null);
    const revealActivity = () => {
        // Let the initiating confirmation close before moving focus to another panel.
        requestAnimationFrame(() => activityControl.current?.open());
    };
    const titles: Readonly<Record<string, string>> = {
        "/settings": "Settings",
        "/infrastructure": "Infrastructure",
        "/jobs": "Jobs",
        "/applications": "Applications",
        "/identity": "Identity",
    };
    const title = titles[location.pathname] ?? "Overview";
    return (
        <JobActivityContext value={revealActivity}>
            <div className="min-h-dvh bg-primary-900 text-primary-50">
                <a
                    className="fixed top-3 left-3 z-50 -translate-y-24 rounded-lg bg-accent-700 px-4 py-3 text-sm font-semibold text-white focus:translate-y-0"
                    href="#main-content"
                >
                    Skip to content
                </a>
                <aside className="fixed inset-y-0 left-0 hidden w-60 flex-col border-r border-primary-700 bg-primary-950 md:flex xl:w-64">
                    <Sidebar />
                </aside>
                <MobileNavigation
                    open={navigationPath === location.pathname}
                    onClose={() => setNavigationPath(undefined)}
                />
                <div className="flex min-h-dvh min-w-0 flex-col md:pl-60 xl:pl-64">
                    <header className="sticky top-0 z-20 flex h-20 shrink-0 items-center justify-between gap-3 border-b border-primary-700 bg-primary-950/95 px-4 backdrop-blur-sm sm:px-5">
                        <div className="flex min-w-0 items-center gap-3">
                            <IconButton
                                icon={Menu}
                                label="Open navigation menu"
                                className="md:hidden"
                                onClick={() => setNavigationPath(location.pathname)}
                            />
                            <p className="truncate text-sm font-medium text-primary-400">
                                <span className="hidden sm:inline">
                                    Homelab
                                    <span className="mx-3 text-primary-600">/</span>
                                </span>
                                <span className="text-primary-100">{title}</span>
                            </p>
                        </div>
                        <div className="flex shrink-0 items-center gap-1">
                            <JobActivity controlRef={activityControl} />
                            <NotificationCenter />
                        </div>
                    </header>
                    <main
                        className="mx-auto w-full max-w-400 min-w-0 flex-1 p-4 sm:p-5"
                        id="main-content"
                        tabIndex={-1}
                    >
                        <Outlet />
                    </main>
                    <footer className="mx-auto w-full max-w-400 px-4 pt-2 pb-5 text-center text-xs text-primary-500 sm:px-5">
                        Homelab Dashboard · Rajohan
                    </footer>
                </div>
            </div>
        </JobActivityContext>
    );
}
