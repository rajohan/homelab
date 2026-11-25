import type { TransactionSQL } from "bun";

import { enqueueJob } from "../../jobs/queue";
import type { JobHandler } from "../../jobs/types";
import { OperationFailure } from "../../operations/errors";
import type { fleetMaintenancePlans } from "./fleetPlans";
import { admitProxmoxRestart } from "./proxmox";

export type FleetEntry = Awaited<ReturnType<typeof fleetMaintenancePlans>>[number];

/** Admit a fresh server-owned recipe under the queue lock.
 * @param tx - Locked admission transaction.
 * @param registry - Registered jobs for the current configuration.
 * @param entry - Plan resolved by the server from current host evidence.
 * @param actor - Authorized operator or update policy.
 * @param requestId - Stable operation identity.
 * @param requiredOnly - Recheck the Linux requirement immediately before a batch action.
 * @returns Identifier and execution channel of the admitted operation.
 */
export async function dispatchRestart(
    tx: TransactionSQL,
    registry: ReadonlyMap<string, JobHandler>,
    entry: FleetEntry,
    actor: string,
    requestId: string,
    requiredOnly: boolean
) {
    const { target, plan, configuration, observation } = entry;
    if (
        !plan.allowed ||
        !observation ||
        (requiredOnly && (plan.kind !== "service" || plan.required !== true))
    )
        throw new OperationFailure(
            "CONFLICT",
            "The restart requirement or service identity changed. Refresh the list."
        );
    if (target.proxmox || target.physicalNode) {
        const { id } = await admitProxmoxRestart(tx, {
            id: requestId,
            actor,
            target: target.id,
            label: target.label,
            revision: plan.revision,
            configuration,
            expected: observation,
            requiredOnly,
            ...(target.reportedOn && target.service
                ? { reportedHost: target.reportedOn, unit: target.service }
                : {}),
        });
        return { id, channel: "controller" as const };
    }
    const handler = registry.get(entry.action);
    if (!handler)
        throw new OperationFailure("NOT_FOUND", "The restart handler is unavailable.");
    const id = await enqueueJob(
        tx,
        handler.definition,
        actor,
        `${actor}:maintenance:${requestId}`,
        {
            target: target.id,
            configuration,
            revision: plan.revision,
            expected: observation,
            ...(requiredOnly ? { requiredOnly: true } : {}),
            ...(target.reportedOn ? { unit: target.service } : {}),
        },
        `Restart ${target.label}`
    );
    return { id, channel: "job" as const };
}
