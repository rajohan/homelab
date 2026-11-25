import { ConfirmDialog } from "@homelab/ui";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { restartGroups, type restartWorkload } from "./restartNavigation";

/** Confirm the exact observed services eligible for a fleet restart.
 * @param props - Selection frozen when the operator opened the dialog and its close handler.
 * @returns Service impacts grouped by host, plus any work left for individual action.
 */
export function RestartBatchDialog({
    workload,
    onClose,
}: {
    readonly workload: ReturnType<typeof restartWorkload>;
    readonly onClose: () => void;
}) {
    const [requestId] = useState(() => crypto.randomUUID());
    const groups = restartGroups(workload.eligible, "", "required", "dashboard");
    const operation = useOperation((_input: void, signal) =>
        api.maintenance.restartAll.mutate(
            {
                targets: workload.eligible.map(({ target, revision }) => ({
                    target,
                    revision,
                })),
                requestId,
            },
            { signal }
        )
    );
    const total = workload.eligible.length;
    return (
        <ConfirmDialog
            title={`Restart ${total} ${total === 1 ? "service" : "services"}?`}
            description="Each service may be briefly unavailable. Recovery is checked before continuing."
            confirmLabel={total === 1 ? "Restart service" : "Restart services"}
            onClose={onClose}
            onConfirm={async () => {
                await operation.mutateAsync();
                onClose();
            }}
        >
            <div className="space-y-3">
                {groups.map(({ host, plans }) => (
                    <section
                        key={host.id}
                        aria-label={host.label}
                        className="rounded-lg border border-primary-700 bg-surface-card p-3"
                    >
                        <h3 className="mb-2 font-semibold text-primary-100">
                            {host.label}
                        </h3>
                        <ul className="divide-y divide-primary-700">
                            {plans.map((plan) => (
                                <li
                                    key={plan.target}
                                    className="min-w-0 py-2 text-sm first:pt-0 last:pb-0"
                                >
                                    <div className="font-medium wrap-anywhere text-primary-100">
                                        {plan.label}
                                    </div>
                                    <p className="mt-1 leading-relaxed text-primary-400">
                                        {plan.impact}
                                    </p>
                                </li>
                            ))}
                        </ul>
                    </section>
                ))}
                {workload.manual.length > 0 && (
                    <p className="text-sm text-primary-300">
                        {workload.manual.length}{" "}
                        {workload.manual.length === 1
                            ? "service requires"
                            : "services require"}{" "}
                        a manual restart.
                    </p>
                )}
                {workload.reboots.length > 0 && (
                    <p className="text-sm text-primary-300">
                        {workload.reboots.length}{" "}
                        {workload.reboots.length === 1
                            ? "host reboot requires"
                            : "host reboots require"}{" "}
                        a separate confirmation.
                    </p>
                )}
                {workload.unavailable.length > 0 && (
                    <p className="text-sm text-primary-300">
                        Currently unavailable for restart: {workload.unavailable.length}.
                    </p>
                )}
            </div>
        </ConfirmDialog>
    );
}
