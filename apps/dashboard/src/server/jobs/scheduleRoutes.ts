import {
    scheduleConfigurationSchema,
    scheduleStateSchema,
    scheduleUpdateSchema,
} from "@homelab/contracts/operations";

import { runOperation, trpc } from "../api/trpc";
import { auditOperation } from "../operations/audit";
import { authorizedOperations } from "../operations/authorization";
import { OperationFailure } from "../operations/errors";
import { listSchedules, lockQueue } from "./queue";
import { nextScheduleOccurrence } from "./scheduleTime";

export const schedulesRouter = trpc.router({
    list: trpc.procedure.query(({ ctx }) =>
        runOperation(async () => {
            const { operations } = authorizedOperations(ctx, "schedules:read");
            return listSchedules(operations.client, operations.registry);
        })
    ),
    preview: trpc.procedure.input(scheduleConfigurationSchema).query(({ ctx, input }) =>
        runOperation(() => {
            authorizedOperations(ctx, "schedules:read");
            try {
                const occurrences: string[] = [];
                let after = Date.now();
                for (let count = 0; count < 3; count += 1) {
                    const next = nextScheduleOccurrence(input, after);
                    occurrences.push(next.toISOString());
                    after = next.getTime();
                }
                return Promise.resolve({ occurrences });
            } catch {
                throw new OperationFailure(
                    "BAD_REQUEST",
                    "Enter a valid schedule with a future occurrence."
                );
            }
        })
    ),
    update: trpc.procedure.input(scheduleUpdateSchema).mutation(({ ctx, input }) =>
        runOperation(async () => {
            const { operations, principal } = authorizedOperations(
                ctx,
                "schedules:write"
            );
            let next: Date;
            try {
                next = nextScheduleOccurrence(input.schedule, Date.now());
            } catch {
                throw new OperationFailure(
                    "BAD_REQUEST",
                    "Enter a valid schedule with a future occurrence."
                );
            }
            await operations.client.begin(async (transaction) => {
                await lockQueue(transaction);
                const changed = await transaction<
                    { action: string }[]
                >`UPDATE job_schedules SET schedule = ${JSON.stringify(input.schedule)}::text::jsonb, next_run_at = ${next}, version = version + 1 WHERE id = ${input.id} AND version = ${input.version} RETURNING action`;
                if (!changed[0] || !operations.registry.has(changed[0].action))
                    throw new OperationFailure(
                        "CONFLICT",
                        "The schedule changed. Refresh before trying again."
                    );
                await auditOperation(
                    transaction,
                    `${principal.kind}:${principal.id}`,
                    "jobs.schedule_changed",
                    input.id
                );
            });
            return { ok: true };
        })
    ),
    setEnabled: trpc.procedure.input(scheduleStateSchema).mutation(({ ctx, input }) =>
        runOperation(async () => {
            const { operations, principal } = authorizedOperations(
                ctx,
                "schedules:write"
            );
            if (input.until !== null && input.until <= Date.now())
                throw new OperationFailure(
                    "BAD_REQUEST",
                    "Choose a future time to resume the schedule."
                );
            await operations.client.begin(async (transaction) => {
                await lockQueue(transaction);
                const [current] = await transaction<
                    {
                        schedule: Parameters<typeof nextScheduleOccurrence>[0];
                        action: string;
                    }[]
                >`SELECT schedule, action FROM job_schedules WHERE id = ${input.id} AND version = ${input.version} FOR UPDATE`;
                if (!current || !operations.registry.has(current.action))
                    throw new OperationFailure(
                        "CONFLICT",
                        "The schedule changed. Refresh before trying again."
                    );
                const next = nextScheduleOccurrence(current.schedule, Date.now());
                await transaction`UPDATE job_schedules SET enabled = ${input.enabled}, disable_reason = ${input.reason}, disabled_until = ${input.until === null ? null : new Date(input.until)}, next_run_at = ${next}, version = version + 1 WHERE id = ${input.id}`;
                await auditOperation(
                    transaction,
                    `${principal.kind}:${principal.id}`,
                    input.enabled ? "jobs.schedule_enabled" : "jobs.schedule_disabled",
                    input.id
                );
            });
            return { ok: true };
        })
    ),
});
