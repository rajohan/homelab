import {
    maintenanceBatchRequestSchema,
    maintenanceRequestSchema,
} from "@homelab/contracts/maintenance";
import { idSchema } from "@homelab/contracts/operations";
import * as v from "valibot";

import { runOperation, trpc } from "../../api/trpc";
import { requireCapability } from "../../automation/authentication";
import { lockQueue } from "../../jobs/queue";
import { authorizedOperations } from "../../operations/authorization";
import type { OperationsContext } from "../../operations/context";
import { OperationFailure } from "../../operations/errors";
import { admitRestartBatch, restartBatchStatus } from "./batch";
import { dispatchRestart } from "./dispatch";
import { fleetMaintenancePlans } from "./fleetPlans";
import { latestProxmoxRestart } from "./proxmox";

async function restartOperator(ctx: OperationsContext) {
    const { operations, principal } = authorizedOperations(ctx, "maintenance:restart");
    requireCapability(principal, "jobs:run");
    if (principal.kind !== "human" || !ctx.verifyHuman)
        throw new OperationFailure(
            "FORBIDDEN",
            "A recently verified human operator must confirm restarts."
        );
    const current = await ctx.verifyHuman();
    if (current.kind !== "human" || current.id !== principal.id)
        throw new OperationFailure("UNAUTHORIZED", "The signed-in account changed.");
    requireCapability(current, "maintenance:restart");
    requireCapability(current, "jobs:run");
    return { operations, actor: `human:${current.id}` };
}

const statusRequest = v.optional(v.strictObject({ id: idSchema }));
export const maintenanceRouter = trpc.router({
    controllerStatus: trpc.procedure.input(statusRequest).query(({ ctx, input }) =>
        runOperation(async () => {
            const { operations, principal } = authorizedOperations(ctx, "updates:read");
            return latestProxmoxRestart(
                operations.client,
                input?.id,
                `${principal.kind}:${principal.id}`
            );
        })
    ),
    batchStatus: trpc.procedure.input(statusRequest).query(({ ctx, input }) =>
        runOperation(async () => {
            const { operations, principal } = authorizedOperations(ctx, "updates:read");
            return restartBatchStatus(
                operations.client,
                input?.id,
                `${principal.kind}:${principal.id}`
            );
        })
    ),
    plans: trpc.procedure.query(({ ctx }) =>
        runOperation(async () => {
            const { operations } = authorizedOperations(ctx, "updates:read");
            const rows = await fleetMaintenancePlans(
                operations.client,
                operations.maintenanceTargets ?? [],
                operations.updateTargets ?? []
            );
            return rows.map((row) => row.plan);
        })
    ),
    restartAll: trpc.procedure
        .input(maintenanceBatchRequestSchema)
        .mutation(({ ctx, input }) =>
            runOperation(async () => {
                const { operations, actor } = await restartOperator(ctx);
                return operations.client.begin(async (tx) => {
                    await lockQueue(tx);
                    const connections = operations.updateTargets ?? [];
                    const rows = await fleetMaintenancePlans(
                        tx,
                        operations.maintenanceTargets ?? [],
                        connections
                    );
                    return admitRestartBatch(
                        tx,
                        actor,
                        input,
                        rows,
                        new Map(connections.map((c) => [c.id, c.host]))
                    );
                });
            })
        ),
    request: trpc.procedure.input(maintenanceRequestSchema).mutation(({ ctx, input }) =>
        runOperation(async () => {
            const { operations, actor } = await restartOperator(ctx);
            return operations.client.begin(async (tx) => {
                await lockQueue(tx);
                const key = `${actor}:maintenance:${input.requestId}`;
                const [prior] = await tx<
                    { id: string; actor: string; target: string; revision: string }[]
                >`SELECT id::text,requested_by AS actor,payload->>'target' AS target,payload->>'revision' AS revision FROM job_runs WHERE idempotency_key=${key}
                UNION ALL SELECT value->>'id',value->>'actor',value->>'target',value->>'revision' FROM operation_snapshots WHERE key=${"maintenance.proxmox.run:" + input.requestId} LIMIT 1`;
                if (prior) {
                    if (
                        prior.actor !== actor ||
                        prior.target !== input.target ||
                        prior.revision !== input.revision
                    )
                        throw new OperationFailure(
                            "CONFLICT",
                            "This request ID belongs to another restart."
                        );
                    return { id: prior.id };
                }
                const rows = await fleetMaintenancePlans(
                    tx,
                    operations.maintenanceTargets ?? [],
                    operations.updateTargets ?? []
                );
                const entry = rows.find((row) => row.target.id === input.target);
                if (
                    !entry ||
                    !entry.plan.allowed ||
                    entry.plan.revision !== input.revision
                )
                    throw new OperationFailure(
                        "CONFLICT",
                        "Restart status changed. Refresh and confirm again."
                    );
                const { id } = await dispatchRestart(
                    tx,
                    operations.registry,
                    entry,
                    actor,
                    input.requestId,
                    Boolean(entry.target.reportedOn)
                );
                return { id };
            });
        })
    ),
});
