import { Link } from "@tanstack/react-router";
import type { LucideIcon } from "lucide-react";
export function NavigationLink({
    to,
    label,
    icon: Icon,
}: {
    readonly to: "/" | "/settings" | "/infrastructure";
    readonly label: string;
    readonly icon: LucideIcon;
}) {
    return (
        <Link
            to={to}
            activeOptions={{ exact: to === "/" }}
            activeProps={{ "aria-current": "page" }}
            className="flex items-center gap-3 rounded-lg px-3.5 py-3 text-sm font-[550] text-[#526176] hover:bg-[#f1f4f8] aria-[current=page]:bg-[#edf2fc] aria-[current=page]:text-[#234e91] max-[640px]:justify-center max-[640px]:gap-1.5 max-[640px]:px-1.75 max-[640px]:py-2.75 max-[640px]:text-xs"
        >
            <Icon className="max-[640px]:w-4" size={19} aria-hidden="true" />
            {label}
        </Link>
    );
}
