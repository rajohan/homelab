import type { UpdateReport } from "@homelab/contracts/updates";

import information from "../../../../../../package.json";
import { runOperation, trpc } from "../../api/trpc";
import { authorizedOperations } from "../../operations/authorization";
import type { readHomelabRelease } from "./read";

export const releasesRouter = trpc.router({
    overview: trpc.procedure.query(({ ctx }) =>
        runOperation(async () => {
            const { operations } = authorizedOperations(ctx, "updates:read");
            const [snapshot] = await operations.client<
                {
                    value: Awaited<ReturnType<typeof readHomelabRelease>>;
                    capturedAt: string;
                    fresh: boolean;
                }[]
            >`SELECT value, captured_at::text AS "capturedAt", captured_at > now() - interval '20 minutes' AS fresh FROM operation_snapshots WHERE key = 'homelab.release'`;
            const [lastCheck] = await operations.client<
                { state: string }[]
            >`SELECT state FROM job_runs WHERE action = 'homelab.release' AND state NOT IN ('queued', 'running') ORDER BY id DESC LIMIT 1`;
            if (snapshot && lastCheck && lastCheck.state !== "succeeded")
                snapshot.fresh = false;
            const workers = await operations.client<
                { version: string; online: boolean; heartbeatAt: string }[]
            >`SELECT version, heartbeat_at > now() - interval '30 seconds' AND NOT draining AS online, heartbeat_at::text AS "heartbeatAt" FROM workers WHERE heartbeat_at > now() - interval '5 minutes' ORDER BY heartbeat_at DESC LIMIT 20`;
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
                release: snapshot?.value.repository === repository ? snapshot : null,
            };
        })
    ),
});
