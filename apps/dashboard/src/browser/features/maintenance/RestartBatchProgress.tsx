import { Badge } from "@homelab/ui";

import type { api } from "../../api/client";

type Batch = NonNullable<Awaited<ReturnType<typeof api.maintenance.batchStatus.query>>>;

const phases = {
    waiting: { label: "Queued", tone: "info" },
    running: { label: "In progress", tone: "info" },
    complete: { label: "Complete", tone: "positive" },
    attention: { label: "Needs attention", tone: "warning" },
} as const;

/** Present the latest restart batch from its persisted status across visits and reconnects.
 * @param props - Most recent batch with per-outcome counts.
 * @returns Current service and completed, skipped or failed work.
 */
export function RestartBatchProgress({ batch }: { readonly batch: Batch }) {
    const phase = phases[batch.phase];
    const counts = [
        `${batch.completed} of ${batch.total} completed`,
        batch.skipped > 0 && `${batch.skipped} skipped`,
        batch.failed > 0 && `${batch.failed} failed`,
    ]
        .filter(Boolean)
        .join(" · ");
    return (
        <div className="rounded-lg border border-primary-700 bg-surface-card p-3 text-sm">
            <output aria-label="Latest restart batch" className="block space-y-1.5">
                <span className="flex flex-wrap items-center gap-2">
                    <strong className="font-semibold text-primary-100">
                        Latest restart batch
                    </strong>
                    <Badge tone={phase.tone}>{phase.label}</Badge>
                </span>
                <span className="block text-primary-300 tabular-nums">{counts}</span>
                {batch.active && (
                    <span className="block wrap-anywhere text-primary-300">
                        Current target · {batch.active}
                    </span>
                )}
            </output>
            {batch.followUp.length > 0 && (
                <details className="mt-3 border-t border-primary-700 pt-1">
                    <summary className="cursor-pointer py-2 font-medium text-accent-300">
                        Review failed restarts ({batch.followUp.length})
                    </summary>
                    <ul className="divide-y divide-primary-700">
                        {batch.followUp.map((service) => (
                            <li
                                key={service.target}
                                className="space-y-1 py-2 wrap-anywhere"
                            >
                                <strong className="font-medium text-primary-100">
                                    {service.label}
                                </strong>
                                <p className="text-primary-300">{service.reason}</p>
                            </li>
                        ))}
                    </ul>
                </details>
            )}
        </div>
    );
}
