import { systemStatusSchema } from "@homelab/contracts";
import { Effect } from "effect";

import { automationRouter } from "../automation/routes";
import { applicationsRouter } from "../integrations/applications/routes";
import { infrastructureRouter } from "../integrations/metrics/routes";
import { jobsRouter } from "../jobs/routes";
import { schedulesRouter } from "../jobs/scheduleRoutes";
import { workerRouter } from "../jobs/workerRoutes";
import { notificationsRouter } from "../notifications/routes";
import { readSystemStatus, SystemStatusLive } from "./system";
import { trpc } from "./trpc";

export const appRouter = trpc.router({
    jobs: jobsRouter,
    schedules: schedulesRouter,
    worker: workerRouter,
    automation: automationRouter,
    infrastructure: infrastructureRouter,
    notifications: notificationsRouter,
    applications: applicationsRouter,
    system: trpc.router({
        status: trpc.procedure
            .output(systemStatusSchema)
            .query(() =>
                Effect.runPromise(readSystemStatus.pipe(Effect.provide(SystemStatusLive)))
            ),
    }),
});

export type AppRouter = typeof appRouter;
