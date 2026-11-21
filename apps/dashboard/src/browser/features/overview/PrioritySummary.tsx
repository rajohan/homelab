import { Card } from "@homelab/ui";
import { CircleCheck, CircleHelp, PackageOpen, TriangleAlert } from "lucide-react";

import { FleetCoverage } from "./FleetCoverage";
import { OverviewLink } from "./OverviewLink";
import { overviewPriorities } from "./overviewPriority";
import type { OverviewReadings } from "./useOverviewReadings";

/** Show the most urgent observation and every other affected domain, with routine maintenance alongside.
 * @returns Current homelab health and links to the source of each reading.
 */
export function PrioritySummary({ readings }: { readonly readings: OverviewReadings }) {
    const [priority, ...others] = overviewPriorities(readings);
    if (!priority) return null;
    const appearance = {
        clear: { icon: CircleCheck, color: "text-emerald-300" },
        warning: { icon: TriangleAlert, color: "text-amber-300" },
        unknown: { icon: CircleHelp, color: "text-primary-300" },
    }[priority.tone];
    const Icon = appearance.icon;
    return (
        <Card
            aria-label="Operational priority"
            className={`grid min-w-0 items-center gap-x-8 gap-y-4 p-4 sm:p-5 @min-[47rem]/overview:grid-cols-[minmax(0,1.5fr)_minmax(15rem,1fr)] ${priority.tone === "clear" ? "bg-coverage-surface border-emerald-300/20" : "border-primary-700 bg-surface-card"}`}
        >
            <div className="min-w-0">
                <div className="flex items-start gap-3">
                    <Icon
                        size={25}
                        aria-hidden="true"
                        className={`mt-1 shrink-0 ${appearance.color}`}
                    />
                    <div className="min-w-0">
                        <h2 className="max-w-[23ch] text-2xl leading-tight font-semibold tracking-tight text-balance wrap-anywhere sm:text-3xl">
                            {priority.title}
                        </h2>
                        <p className="mt-2 max-w-prose text-sm leading-relaxed text-primary-300">
                            {priority.detail}
                        </p>
                        {priority.tone !== "clear" && (
                            <OverviewLink
                                to={priority.to}
                                hash={priority.hash}
                                incident={priority.incident}
                            >
                                {priority.action}
                            </OverviewLink>
                        )}
                        {priority.tone === "clear" && readings.available > 0 && (
                            <div className="mt-1 flex items-center gap-2 text-accent-300">
                                <PackageOpen size={15} aria-hidden="true" />
                                <OverviewLink to="/updates">
                                    {readings.available} updates available
                                </OverviewLink>
                            </div>
                        )}
                    </div>
                </div>
            </div>
            <FleetCoverage readings={readings} />
            {others.length > 0 && (
                <ul
                    aria-label="Also needs attention"
                    className="flex flex-wrap gap-x-5 border-t border-primary-700 @min-[47rem]/overview:col-span-2"
                >
                    {others.map((item) => (
                        <li key={item.action}>
                            <OverviewLink
                                to={item.to}
                                hash={item.hash}
                                incident={item.incident}
                            >
                                {item.title}
                            </OverviewLink>
                        </li>
                    ))}
                </ul>
            )}
        </Card>
    );
}
