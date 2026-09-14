import { Badge } from "@homelab/ui";
import { Outlet } from "@tanstack/react-router";

import { Sidebar } from "./Sidebar";

export function Shell() {
    return (
        <div className="grid min-h-screen grid-cols-[250px_minmax(0,1fr)] max-[1050px]:grid-cols-[210px_minmax(0,1fr)] max-[640px]:block">
            <a
                className="absolute -top-20 left-3.75 z-10 rounded-md border border-[#ccdbee] bg-white px-4.5 py-3 focus:top-3"
                href="#main-content"
            >
                Skip to content
            </a>
            <Sidebar />
            <div className="flex min-w-0 flex-col">
                <header className="flex min-h-19.25 items-center justify-between gap-4 border-b border-[#e0e6ee] px-10.5 py-4.5 text-xs text-[#64738a] max-[1050px]:px-6.25 max-[640px]:min-h-15 max-[640px]:px-5 max-[640px]:py-3">
                    <span>Workspace / Homelab</span>
                    <Badge>Identity preview</Badge>
                </header>
                <main
                    className="mx-auto w-full max-w-312.5 flex-1 px-10.5 pt-12.25 pb-15 max-[1050px]:px-6.25 max-[1050px]:py-8 max-[640px]:px-4.5 max-[640px]:py-7.5 min-[1500px]:pt-16.25"
                    id="main-content"
                    tabIndex={-1}
                >
                    <Outlet />
                </main>
                <footer className="px-10.5 pb-6.25 text-[0.7rem] text-[#8490a0] max-[1050px]:px-6.25 max-[640px]:pl-5">
                    Independent services. Shared foundation.
                </footer>
            </div>
        </div>
    );
}
