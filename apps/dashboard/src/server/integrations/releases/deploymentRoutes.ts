import * as v from "valibot";

import { runOperation, trpc } from "../../api/trpc";
import { requireCapability } from "../../automation/authentication";
import { lockQueue } from "../../jobs/queue";
import { auditOperation } from "../../operations/audit";
import { authorizedOperations } from "../../operations/authorization";
import type { OperationsContext } from "../../operations/context";
import { OperationFailure } from "../../operations/errors";
import { preparedDeployment } from "./deploymentPlans";

const requestSchema = v.strictObject({
    target: v.pipe(v.string(), v.regex(/^[a-z][a-z0-9-]{0,49}$/)),
    revision: v.pipe(v.string(), v.regex(/^[a-f0-9]{64}$/)),
    requestId: v.pipe(v.string(), v.uuid()),
});
async function authorize(context: OperationsContext) {
    const { operations, principal } = authorizedOperations(context, "updates:apply");
    requireCapability(principal, "jobs:run");
    if (principal.kind !== "human" || !context.verifyHuman)
        throw new OperationFailure(
            "FORBIDDEN",
            "A recently verified human must confirm deployment."
        );
    const current = await context.verifyHuman();
    if (current.kind !== "human" || current.id !== principal.id)
        throw new OperationFailure("UNAUTHORIZED", "The signed-in account changed.");
    requireCapability(current, "updates:apply");
    requireCapability(current, "jobs:run");
    return { operations, actor: `human:${current.id}` };
}

export const deploymentRouter = trpc.router({
    overview: trpc.procedure.query(({ ctx }) =>
        runOperation(async () => {
            const { operations } = authorizedOperations(ctx, "updates:read");
            const targets = await Promise.all(
                (operations.deploymentTargets ?? []).map(async (target) => {
                    const prepared = await preparedDeployment(
                        operations.client,
                        target,
                        operations.updateTargets ?? []
                    );
                    return {
                        id: target.id,
                        label: target.label,
                        version: prepared.plan?.release.version ?? null,
                        revision: prepared.revision,
                    };
                })
            );
            const history = await operations.client<
                {
                    id: string;
                    target: string;
                    version: string;
                    state: string;
                    phase: string;
                    message: string | null;
                    active: boolean;
                }[]
            >`
            SELECT id,target,plan->'release'->>'version' AS version,state,phase,message,finished_at IS NULL AS active
            FROM release_deployments ORDER BY id DESC LIMIT 10`;
            return { targets, history };
        })
    ),
    request: trpc.procedure.input(requestSchema).mutation(({ ctx, input }) =>
        runOperation(async () => {
            const { operations, actor } = await authorize(ctx);
            const target = operations.deploymentTargets?.find(
                (entry) => entry.id === input.target
            );
            if (!target || !operations.releaseRepository)
                throw new OperationFailure("NOT_FOUND", "Deployment is not configured.");
            return operations.client.begin(async (transaction) => {
                await lockQueue(transaction);
                const key = `${actor}:deployment:${input.requestId}`;
                const [existing] = await transaction<
                    { id: string; target: string; requestRevision: string }[]
                >`
                SELECT id,target,confirmation_revision AS "requestRevision" FROM release_deployments WHERE request_key=${key}`;
                if (existing) {
                    if (
                        existing.target !== input.target ||
                        existing.requestRevision !== input.revision
                    )
                        throw new OperationFailure(
                            "CONFLICT",
                            "This request ID belongs to another deployment."
                        );
                    return { id: existing.id };
                }
                const [active] = await transaction<
                    { id: string }[]
                >`SELECT id FROM release_deployments WHERE finished_at IS NULL`;
                if (active)
                    throw new OperationFailure(
                        "CONFLICT",
                        "A deployment already requires completion or recovery."
                    );
                const prepared = await preparedDeployment(
                    transaction,
                    target,
                    operations.updateTargets ?? []
                );
                if (
                    !prepared.plan ||
                    prepared.plan.release.repository !== operations.releaseRepository ||
                    prepared.revision !== input.revision
                )
                    throw new OperationFailure(
                        "CONFLICT",
                        "Prepare and confirm the current release again."
                    );
                const [workers] = await transaction<
                    { current: number; legacy: number }[]
                >`
                SELECT count(*) FILTER (WHERE deployment_protocol=1)::int AS current,count(*) FILTER (WHERE deployment_protocol<>1)::int AS legacy
                FROM workers WHERE heartbeat_at>now()-interval '30 seconds' AND NOT draining`;
                if (!workers?.current || workers.legacy)
                    throw new OperationFailure(
                        "PRECONDITION_FAILED",
                        "A current deployment-capable worker must be running."
                    );
                const id = Bun.randomUUIDv7();
                await transaction`INSERT INTO release_deployments (id,target,requested_by,request_key,confirmation_revision,configuration,plan,state,phase,message)
                VALUES (${id},${target.id},${actor},${key},${input.revision},${prepared.plan.configuration},${JSON.stringify(prepared.plan)}::text::jsonb,'waiting','draining','Waiting for active work to finish.')`;
                await auditOperation(transaction, actor, "releases.requested", id);
                return { id };
            });
        })
    ),
    cancel: trpc.procedure
        .input(v.strictObject({ id: v.pipe(v.string(), v.uuid()) }))
        .mutation(({ ctx, input }) =>
            runOperation(async () => {
                const { operations, actor } = await authorize(ctx);
                return operations.client.begin(async (transaction) => {
                    await lockQueue(transaction);
                    const rows = await transaction<{ id: string }[]>`
                UPDATE release_deployments SET state='cancelled',phase='cancelled',finished_at=now(),updated_at=now(),message='Cancelled before replacement started.'
                WHERE id=${input.id} AND state='waiting' AND finished_at IS NULL RETURNING id`;
                    if (rows.length === 0)
                        throw new OperationFailure(
                            "CONFLICT",
                            "Only a deployment waiting for active work can be cancelled."
                        );
                    await auditOperation(
                        transaction,
                        actor,
                        "releases.cancelled",
                        input.id
                    );
                    return { id: input.id };
                });
            })
        ),
});
