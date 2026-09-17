import { workerControlSchema } from "@homelab/contracts/operations";

import { runOperation, trpc } from "../api/trpc";
import { authorizedOperations } from "../operations/authorization";
import { readWorkerControl, setWorkerControl } from "./control";

export const workerRouter = trpc.router({
    overview: trpc.procedure.query(({ ctx }) =>
        runOperation(async () => {
            const { operations } = authorizedOperations(ctx, "worker:read");
            const workers = await operations.client<
                {
                    id: string;
                    version: string;
                    heartbeatAt: string;
                    startedAt: string;
                    capacity: number;
                    active: number;
                    draining: boolean;
                    online: boolean;
                }[]
            >`SELECT id, version, heartbeat_at::text AS "heartbeatAt", started_at::text AS "startedAt", capacity, draining, (heartbeat_at > now() - interval '30 seconds' AND NOT draining) AS online, (SELECT count(*)::int FROM job_runs WHERE worker_id = workers.id AND state = 'running') AS active FROM workers ORDER BY heartbeat_at DESC LIMIT 20`;
            const counts = await operations.client<
                { state: string; count: number }[]
            >`SELECT state, count(*)::int AS count FROM job_runs GROUP BY state`;
            const [queue] = await operations.client<
                { oldestQueuedAt: string | null }[]
            >`SELECT min(created_at)::text AS "oldestQueuedAt" FROM job_runs WHERE state = 'queued'`;
            return {
                workers,
                counts,
                control: await readWorkerControl(operations.client),
                oldestQueuedAt: queue?.oldestQueuedAt ?? null,
            };
        })
    ),
    setPaused: trpc.procedure.input(workerControlSchema).mutation(({ ctx, input }) =>
        runOperation(async () => {
            const { operations, principal } = authorizedOperations(ctx, "worker:control");
            await setWorkerControl(
                operations.client,
                `${principal.kind}:${principal.id}`,
                input
            );
            return { ok: true };
        })
    ),
});
