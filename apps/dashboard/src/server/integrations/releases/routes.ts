import { listMiraComputers } from "@homelab/mira/data/computers";

import information from "../../../../../../package.json";
import { runOperation, trpc } from "../../api/trpc";
import { authorizedOperations } from "../../operations/authorization";
import { authReleaseObservations } from "./authObservations";
import { deploymentRouter } from "./deploymentRoutes";
import { releaseSnapshot } from "./snapshot";

export const releasesRouter = trpc.router({
    deployment: deploymentRouter,
    overview: trpc.procedure.query(({ ctx }) =>
        runOperation(async () => {
            const { operations, principal } = authorizedOperations(ctx, "updates:read");
            const snapshot = await releaseSnapshot(
                operations.client,
                operations.releaseRepository
            );
            const workers = await operations.client<
                { version: string; online: boolean; heartbeatAt: string }[]
            >`SELECT version, heartbeat_at > now() - interval '30 seconds' AND NOT draining AS online, heartbeat_at::text AS "heartbeatAt" FROM workers WHERE heartbeat_at > now() - interval '5 minutes' ORDER BY heartbeat_at DESC LIMIT 20`;
            const [mira] = await operations.client<
                { version: string; ready: boolean; online: boolean }[]
            >`SELECT version,ready,heartbeat_at>now()-interval '30 seconds' AS online FROM mira_runtime_status WHERE id=1`;
            const computersAvailable =
                principal.kind === "human" &&
                principal.capabilities.includes("jobs:read");
            const computers = computersAvailable
                ? await listMiraComputers({
                      client: operations.client,
                      owner: principal.id,
                      actor: `human:${principal.id}`,
                  })
                : [];
            const repository = operations.releaseRepository;
            const auth = await authReleaseObservations({
                client: operations.client,
                repository,
                sources: operations.updateSources ?? [],
                targets: operations.deploymentTargets ?? [],
                connections: operations.updateTargets ?? [],
            });
            return {
                configured: Boolean(repository),
                dashboard: information.version,
                workers,
                auth,
                mira: mira ?? null,
                computersAvailable,
                computers: computers.filter(
                    (computer) =>
                        computer.state === "paired" &&
                        Date.parse(computer.expiresAt) > Date.now()
                ),
                release: snapshot,
            };
        })
    ),
});
