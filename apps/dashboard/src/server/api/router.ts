import { systemStatusSchema } from "@homelab/contracts";
import type { InfrastructureSnapshot } from "@homelab/contracts/operations";
import { Effect } from "effect";

import { automationRouter } from "../automation/routes";
import { jobsRouter } from "../jobs/routes";
import { schedulesRouter } from "../jobs/scheduleRoutes";
import { workerRouter } from "../jobs/workerRoutes";
import { authorizedOperations } from "../operations/authorization";
import { readSystemStatus, SystemStatusLive } from "./system";
import { runOperation, trpc } from "./trpc";

export const appRouter = trpc.router({
    jobs: jobsRouter,
    schedules: schedulesRouter,
    worker: workerRouter,
    automation: automationRouter,
    infrastructure: trpc.router({
        summary: trpc.procedure.query(({ ctx }) =>
            runOperation(async () => {
                const { operations } = authorizedOperations(ctx, "infrastructure:read");
                const rows = await operations.client<
                    { value: InfrastructureSnapshot }[]
                >`SELECT value FROM operation_snapshots WHERE key = 'infrastructure'`;
                return rows[0]?.value ?? null;
            })
        ),
    }),
    system: trpc.router({
        status: trpc.procedure
            .output(systemStatusSchema)
            .query(() =>
                Effect.runPromise(readSystemStatus.pipe(Effect.provide(SystemStatusLive)))
            ),
    }),
});

export type AppRouter = typeof appRouter;
