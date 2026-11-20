import { Link } from "@tanstack/react-router";
import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";

/** Open a dashboard detail page from a summary, using the same visible action in each section.
 * @returns A keyboard-accessible navigation link.
 */
export function OverviewLink({
    to,
    children,
}: {
    readonly to:
        | "/infrastructure"
        | "/applications"
        | "/alerts"
        | "/backups"
        | "/jobs"
        | "/updates";
    readonly children: ReactNode;
}) {
    return (
        <Link
            to={to}
            className="text-workspace-accent inline-flex min-h-11 items-center gap-1.5 rounded text-sm font-medium hover:underline"
        >
            {children}
            <ArrowRight size={15} aria-hidden="true" />
        </Link>
    );
}
