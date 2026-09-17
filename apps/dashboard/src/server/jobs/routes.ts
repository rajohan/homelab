import {
    idSchema,
    pageSchema,
    runFilterSchema,
    runJobSchema,
    type JobSummary,
} from "@homelab/contracts/operations";
import * as v from "valibot";

import { runOperation, trpc } from "../api/trpc";
import { requireCapability } from "../automation/authentication";
import { auditOperation } from "../operations/audit";
import { authorizedOperations } from "../operations/authorization";
import { OperationFailure } from "../operations/errors";
import { enqueueJob, listJobs, lockQueue } from "./queue";

export const jobsRouter = trpc.router({
    list: trpc.procedure.input(runFilterSchema).query(({ ctx, input }) =>
        runOperation(async () => {
            const { operations } = authorizedOperations(ctx, "jobs:read");
            const runs = await listJobs(
                operations.client,
                input.limit,
                input.before,
                input
            );
            return {
                runs,
                nextCursor:
                    runs.length === input.limit ? (runs.at(-1)?.id ?? null) : null,
            };
        })
    ),
    detail: trpc.procedure
        .input(v.strictObject({ ...pageSchema.entries, id: idSchema }))
        .query(({ ctx, input }) =>
            runOperation(async () => {
                const { operations } = authorizedOperations(ctx, "jobs:read");
                const [run] = await operations.client<
                    (JobSummary & {
                        resourceKeys: string[];
                        timeoutMs: number;
                        retrySafe: boolean;
                    })[]
                >`SELECT id, action, label, resource_class AS "resourceClass", state, attempt, attempt_limit AS "attemptLimit", requested_by AS "requestedBy", created_at::text AS "createdAt", started_at::text AS "startedAt", finished_at::text AS "finishedAt", message, cancel_requested AS "cancelRequested", resource_keys AS "resourceKeys", timeout_ms AS "timeoutMs", retry_safe AS "retrySafe" FROM job_runs WHERE id = ${input.id}`;
                if (!run)
                    throw new OperationFailure(
                        "NOT_FOUND",
                        "This run was not found or its history has expired."
                    );
                const events = await operations.client<
                    { id: string; actor: string; action: string; createdAt: string }[]
                >`SELECT id, actor, action, created_at::text AS "createdAt" FROM operation_audit WHERE target = ${input.id} AND (${input.before ?? null}::uuid IS NULL OR id < ${input.before ?? null}::uuid) ORDER BY id DESC LIMIT ${input.limit}`;
                return {
                    run,
                    events,
                    nextCursor:
                        events.length === input.limit
                            ? (events.at(-1)?.id ?? null)
                            : null,
                };
            })
        ),
    run: trpc.procedure.input(runJobSchema).mutation(({ ctx, input }) =>
        runOperation(async () => {
            const { operations, principal } = authorizedOperations(ctx, "jobs:run");
            const definition = operations.registry.get(input.action)?.definition;
            if (!definition)
                throw new OperationFailure("NOT_FOUND", "This job is not registered.");
            requireCapability(principal, definition.capability);
            return operations.client.begin(async (transaction) => {
                await lockQueue(transaction);
                return {
                    id: await enqueueJob(
                        transaction,
                        definition,
                        `${principal.kind}:${principal.id}`,
                        `${principal.kind}:${principal.id}:${input.requestId}`,
                        input.payload
                    ),
                };
            });
        })
    ),
    cancel: trpc.procedure
        .input(v.strictObject({ id: idSchema }))
        .mutation(({ ctx, input }) =>
            runOperation(async () => {
                const { operations, principal } = authorizedOperations(
                    ctx,
                    "jobs:cancel"
                );
                await operations.client.begin(async (transaction) => {
                    await lockQueue(transaction);
                    const rows = await transaction<
                        { id: string }[]
                    >`UPDATE job_runs SET cancel_requested = true, state = CASE WHEN state = 'queued' THEN 'cancelled' ELSE state END, finished_at = CASE WHEN state = 'queued' THEN now() ELSE finished_at END WHERE id = ${input.id} AND state IN ('queued','running') AND NOT cancel_requested RETURNING id`;
                    if (rows[0])
                        await auditOperation(
                            transaction,
                            `${principal.kind}:${principal.id}`,
                            "jobs.cancel_requested",
                            input.id
                        );
                });
                return { ok: true };
            })
        ),
});
