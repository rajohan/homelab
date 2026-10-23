import { Badge, SectionIcon } from "@homelab/ui";
import { Server } from "lucide-react";
import { useId } from "react";

import type { RestartGroup, RestartPlan } from "./restartNavigation";
import { RestartTargetCard } from "./RestartTargetCard";

/**
 * Keep one host's filtered targets together under a named heading.
 * @returns A host group with required targets ordered first by the navigation model.
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
        <section aria-labelledby={heading} className="space-y-3">
            <div className="flex items-center gap-3">
                <SectionIcon icon={Server} />
                <h3 id={heading} className="font-semibold">
                    {group.host.label}
                </h3>
                {group.required > 0 && (
                    <Badge className="self-center" tone="warning">
                        {group.required} required
                    </Badge>
                )}
            </div>
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
        </section>
    );
}
