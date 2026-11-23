import { maintenanceRequestSchema } from "@homelab/contracts/maintenance";

import { runOperation, trpc } from "../../api/trpc";
import { requireCapability } from "../../automation/authentication";
import { enqueueJob, lockQueue } from "../../jobs/queue";
import { authorizedOperations } from "../../operations/authorization";
import { OperationFailure } from "../../operations/errors";
import { maintenanceHosts } from "./hosts";
import { maintenancePlan, type MaintenanceReading } from "./jobs";
import { admitProxmoxRestart, latestProxmoxRestart } from "./proxmox";

export const maintenanceRouter = trpc.router({
    controllerStatus: trpc.procedure.query(({ ctx }) =>
        runOperation(async () => {
            const { operations } = authorizedOperations(ctx, "updates:read");
            return latestProxmoxRestart(operations.client);
        })
    ),
    plans: trpc.procedure.query(({ ctx }) =>
        runOperation(async () => {
            const { operations } = authorizedOperations(ctx, "updates:read");
            const hosts = maintenanceHosts(
                operations.maintenanceTargets ?? [],
                operations.updateTargets ?? []
            );
            const readings = await operations.client<
                (MaintenanceReading & { key: string })[]
            >`SELECT key,value,captured_at::text AS "capturedAt",captured_at > now()-interval '2 minutes' AS fresh FROM operation_snapshots WHERE key LIKE 'maintenance:%'`;
            const byKey = new Map(readings.map((row) => [row.key, row]));
            return Promise.all(
                (operations.maintenanceTargets ?? []).map(async (target) => {
                    const {
                        observation,
                        configuration: _configuration,
                        ...plan
                    } = await maintenancePlan(
                        operations.client,
                        target,
                        operations.updateTargets ?? [],
                        byKey.get(`maintenance:${target.id}`) ?? null
                    );
                    return {
                        ...plan,
                        host: hosts.get(target.id)!,
                        serviceEvidence: observation?.serviceEvidence ?? null,
                        observed: Boolean(observation),
                        active: observation?.active ?? null,
                        required:
                            target.kind === "host"
                                ? (observation?.rebootRequired ?? null)
                                : (observation?.serviceRestartRequired ?? null),
                    };
                })
            );
        })
    ),
    request: trpc.procedure.input(maintenanceRequestSchema).mutation(({ ctx, input }) =>
        runOperation(async () => {
            const { operations, principal } = authorizedOperations(
                ctx,
                "maintenance:restart"
            );
            requireCapability(principal, "jobs:run");
            if (principal.kind !== "human" || !ctx.verifyHuman)
                throw new OperationFailure(
                    "FORBIDDEN",
                    "A recently verified human operator must confirm restarts."
                );
            const current = await ctx.verifyHuman();
            if (current.kind !== "human" || current.id !== principal.id)
                throw new OperationFailure(
                    "UNAUTHORIZED",
                    "The signed-in account changed."
                );
            requireCapability(current, "maintenance:restart");
            requireCapability(current, "jobs:run");
            const target = operations.maintenanceTargets?.find(
                (entry) => entry.id === input.target
            );
            const connection =
                target &&
                operations.updateTargets?.find((entry) => entry.id === target.connection);
            const handler = operations.registry.get(
                `maintenance.restart.${input.target}`
            );
            if (!target || !connection || (!handler && !target.proxmox))
                throw new OperationFailure(
                    "NOT_FOUND",
                    "This restart target is not configured."
                );
            return operations.client.begin(async (transaction) => {
                await lockQueue(transaction);
                const actor = `human:${current.id}`;
                const key = `${actor}:maintenance:${input.requestId}`;
                const [existing] = await transaction<
                    { id: string; payload: { target: string; revision: string } }[]
                >`SELECT id, payload FROM job_runs WHERE idempotency_key = ${key}`;
                if (existing) {
                    if (
                        existing.payload.target !== input.target ||
                        existing.payload.revision !== input.revision
                    )
                        throw new OperationFailure(
                            "CONFLICT",
                            "This request ID belongs to another restart."
                        );
                    return { id: existing.id };
                }
                if (target.proxmox) {
                    const [previous] = await transaction<
                        { value: { actor: string; target: string; revision: string } }[]
                    >`SELECT value FROM operation_snapshots WHERE key=${`maintenance.proxmox.run:${input.requestId}`}`;
                    if (previous) {
                        if (
                            previous.value.actor !== actor ||
                            previous.value.target !== target.id ||
                            previous.value.revision !== input.revision
                        )
                            throw new OperationFailure(
                                "CONFLICT",
                                "This confirmation belongs to another operation."
                            );
                        return { id: input.requestId };
                    }
                }
                const plan = await maintenancePlan(
                    transaction,
                    target,
                    operations.updateTargets ?? []
                );
                if (
                    !plan.allowed ||
                    !plan.observation ||
                    plan.revision !== input.revision
                )
                    throw new OperationFailure(
                        "CONFLICT",
                        "Restart status changed. Refresh and confirm again."
                    );
                if (target.proxmox)
                    return admitProxmoxRestart(transaction, {
                        id: input.requestId,
                        actor,
                        target: target.id,
                        label: target.label,
                        revision: input.revision,
                        configuration: plan.configuration,
                        expected: plan.observation,
                    });
                return {
                    id: await enqueueJob(transaction, handler!.definition, actor, key, {
                        target: target.id,
                        configuration: plan.configuration,
                        revision: input.revision,
                        expected: plan.observation,
                    }),
                };
            });
        })
    ),
});
