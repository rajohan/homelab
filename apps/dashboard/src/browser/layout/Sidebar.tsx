import { Link } from "@tanstack/react-router";
import { Blocks, LayoutDashboard, Server, ShieldCheck } from "lucide-react";

import { NavigationLink } from "./NavigationLink";

export function Sidebar() {
    return (
        <aside className="flex flex-col border-r border-[#e0e6ee] bg-white px-5 pt-8.5 pb-6.25 max-[640px]:border-r-0 max-[640px]:border-b max-[640px]:px-4 max-[640px]:pt-5 max-[640px]:pb-3">
            <Link
                to="/"
                className="mx-1.5 mb-10.5 flex items-center gap-2.75 text-[1.2rem] font-bold tracking-[-0.04em] max-[640px]:mx-0 max-[640px]:mb-5"
                aria-label="Homelab overview"
            >
                <span className="grid size-10.5 shrink-0 place-items-center rounded-[11px] bg-[#254b8b] text-white">
                    <Blocks size={23} aria-hidden="true" />
                </span>
                <span>
                    Homelab
                    <span className="mt-0.75 block text-[0.65rem] font-normal tracking-normal text-[#64738a] max-[1050px]:text-[0.57rem] max-[640px]:text-[0.65rem]">
                        One place. Your infrastructure.
                    </span>
                </span>
            </Link>
            <nav
                className="grid gap-1.75 max-[640px]:grid-cols-3 max-[640px]:gap-1.25"
                aria-label="Main navigation"
            >
                <NavigationLink to="/" label="Overview" icon={LayoutDashboard} />
                <NavigationLink to="/settings" label="Settings" icon={ShieldCheck} />
                <NavigationLink
                    to="/infrastructure"
                    label="Infrastructure"
                    icon={Server}
                />
            </nav>
            <div className="mt-auto px-3.25 pt-10 max-[640px]:hidden">
                <span className="text-[0.65rem] font-[650] tracking-[0.12em] text-[#68798e] uppercase">
                    Project status
                </span>
                <p className="my-1.25 text-[0.925rem] leading-[1.7] font-semibold text-[#33465c]">
                    Identity preview
                </p>
                <span className="block text-xs leading-[1.6] text-[#6d7989]">
                    Account security is ready for validation. Infrastructure integrations
                    come next.
                </span>
            </div>
        </aside>
    );
}
