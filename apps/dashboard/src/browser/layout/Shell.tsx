import { Badge, IconButton } from "@homelab/ui";
import { Outlet, useLocation } from "@tanstack/react-router";
import { Menu } from "lucide-react";
import { useState } from "react";

import { MobileNavigation } from "./MobileNavigation";
import { Sidebar } from "./Sidebar";

export function Shell() {
    const location = useLocation();
    const [navigationPath, setNavigationPath] = useState<string>();
    const titles: Readonly<Record<string, string>> = {
        "/settings": "Settings",
        "/infrastructure": "Infrastructure",
        "/identity": "Identity",
    };
    const title = titles[location.pathname] ?? "Overview";
    return (
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
                <header className="sticky top-0 z-20 flex h-20 shrink-0 items-center justify-between gap-3 border-b border-primary-700 bg-primary-950/95 px-4 backdrop-blur-sm sm:px-6 lg:px-8">
                    <div className="flex min-w-0 items-center gap-3">
                        <IconButton
                            icon={Menu}
                            label="Open navigation menu"
                            className="md:hidden"
                            onClick={() => setNavigationPath(location.pathname)}
                        />
                        <p className="truncate text-sm font-medium text-primary-400">
                            <span className="hidden sm:inline">
                                Homelab<span className="mx-3 text-primary-600">/</span>
                            </span>
                            <span className="text-primary-100">{title}</span>
                        </p>
                    </div>
                    <Badge>Preview</Badge>
                </header>
                <main
                    className="mx-auto w-full max-w-7xl min-w-0 flex-1 px-4 py-7 sm:px-6 sm:py-9 lg:px-8"
                    id="main-content"
                    tabIndex={-1}
                >
                    <Outlet />
                </main>
                <footer className="px-4 py-5 text-xs text-primary-500 sm:px-6 lg:px-8">
                    Rajohan · Homelab
                </footer>
            </div>
        </div>
    );
}
