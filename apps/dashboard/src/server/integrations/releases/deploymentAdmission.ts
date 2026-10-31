import type { TransactionSQL } from "bun";

import { auditOperation } from "../../operations/audit";
import { OperationFailure } from "../../operations/errors";
import type { DeploymentPlan } from "./deploymentProtocol";

/**
 * Admit a frozen deployment while the caller holds the global queue lock.
 * @param query - Transaction serialized with worker claims and policy changes.
 * @param input - Trusted manual confirmation or qualified automatic-policy decision.
 * @returns A durable operation ID; duplicate keys must be handled before invoking this boundary.
 */
export async function admitDeployment(
    query: TransactionSQL,
    input: {
        target: string;
        actor: string;
        key: string;
        revision: string;
        plan: DeploymentPlan;
        automatic?: { version: number; windowEndsAt: number };
    }
): Promise<{ id: string }> {
    const [active] = await query<
        { id: string }[]
    >`SELECT id FROM release_deployments WHERE finished_at IS NULL`;
    if (active)
        throw new OperationFailure(
            "CONFLICT",
            "A deployment already requires completion or recovery."
        );
    const [workers] = await query<
        { current: number; legacy: number }[]
    >`SELECT count(*) FILTER(WHERE deployment_protocol=1)::int AS current,count(*) FILTER(WHERE deployment_protocol<>1)::int AS legacy FROM workers WHERE heartbeat_at>clock_timestamp()-interval '30 seconds' AND NOT draining`;
    if (!workers?.current || workers.legacy)
        throw new OperationFailure(
            "PRECONDITION_FAILED",
            "A current deployment-capable worker must be running."
        );
    const id = Bun.randomUUIDv7();
    await query`INSERT INTO release_deployments(id,target,requested_by,request_key,confirmation_revision,configuration,plan,state,phase,message,policy_version,window_ends_at)
 VALUES(${id},${input.target},${input.actor},${input.key},${input.revision},${input.plan.configuration},${JSON.stringify(input.plan)}::text::jsonb,'waiting','draining','Waiting for active work to finish.',${input.automatic?.version ?? null},${input.automatic ? new Date(input.automatic.windowEndsAt) : null})`;
    await query`DELETE FROM operation_snapshots WHERE key LIKE 'homelab.prepare.%'`;
    await auditOperation(query, input.actor, "releases.requested", id);
    return { id };
}
