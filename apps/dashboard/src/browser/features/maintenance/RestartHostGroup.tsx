import { Badge, HeadingLabel } from "@homelab/ui";
import { Server } from "lucide-react";
import { useId } from "react";

import type { RestartGroup, RestartPlan } from "./restartNavigation";
import { RestartTargetCard } from "./RestartTargetCard";

/** Group the host reboot and service rows on one named surface.
 * @param props - Filtered host group, control states and individual row actions.
 * @returns A named host section with the matching targets.
 */
export function RestartHostGroup({
    group,
    refreshing,
    stale,
    onRefresh,
    onRestart,
}: {
    readonly group: RestartGroup;
    readonly refreshing: boolean;
    readonly stale: boolean;
    readonly onRefresh: (plan: RestartPlan) => void;
    readonly onRestart: (plan: RestartPlan) => void;
}) {
    const heading = useId();
    return (
        <section
            aria-labelledby={heading}
            className="min-w-0 rounded-lg border border-primary-700 bg-surface-card"
        >
            <header className="flex flex-wrap items-center gap-2 border-b border-primary-700 px-3 py-2.5 sm:px-4">
                <h3 id={heading} className="min-w-0 font-semibold">
                    <HeadingLabel icon={Server}>{group.host.label}</HeadingLabel>
                </h3>
                {group.required > 0 && (
                    <Badge tone="warning">{group.required} required</Badge>
                )}
            </header>
            <ul className="divide-y divide-primary-700 p-3 sm:px-4">
                {group.plans.map((plan) => (
                    <RestartTargetCard
                        key={plan.target}
                        plan={plan}
                        refreshing={refreshing}
                        stale={stale}
                        onRefresh={onRefresh}
                        onRestart={onRestart}
                    />
                ))}
            </ul>
        </section>
    );
}
