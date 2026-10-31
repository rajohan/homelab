import type { UpdateReport } from "@homelab/contracts/updates";
import { listMiraComputers } from "@homelab/mira/data/computers";

import information from "../../../../../../package.json";
import { runOperation, trpc } from "../../api/trpc";
import { authorizedOperations } from "../../operations/authorization";
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
            const reports = await operations.client<
                { key: string; value: UpdateReport }[]
            >`SELECT key, value FROM operation_snapshots WHERE key LIKE 'updates:%'`;
            const repository = operations.releaseRepository;
            const sources = new Set(
                (operations.updateSources ?? []).map((source) => `updates:${source.id}`)
            );
            const auth = reports
                .filter((report) => sources.has(report.key))
                .flatMap((report) =>
                    report.value.items
                        .filter(
                            (item) =>
                                repository &&
                                item.image?.startsWith(
                                    `ghcr.io/${repository.toLowerCase()}/auth:`
                                )
                        )
                        .map((item) => ({
                            name: item.name,
                            version:
                                item.installedVersion ??
                                item.image!.split(":")[1]?.split("@")[0] ??
                                "unknown",
                            image: item.image!,
                            capturedAt: report.value.capturedAt,
                            stale:
                                !report.value.complete ||
                                Date.parse(report.value.capturedAt) <
                                    Date.now() - 26 * 3_600_000,
                        }))
                );
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
