import {
    incidentPageSchema,
    type Incident,
    type RuleInventory,
} from "@homelab/contracts/alerts";

import { runOperation, trpc } from "../../api/trpc";
import { authorizedOperations } from "../../operations/authorization";

export const alertsRouter = trpc.router({
    rules: trpc.procedure.query(({ ctx }) =>
        runOperation(async () => {
            const { operations } = authorizedOperations(ctx, "alerts:read");
            const [row] = await operations.client<
                { value: RuleInventory; stale: boolean }[]
            >`SELECT value, captured_at < now() - interval '3 minutes' AS stale FROM operation_snapshots WHERE key = 'monitoring.rules'`;
            return {
                configured: Boolean(operations.rules),
                inventory: row?.value ?? null,
                stale: row?.stale ?? true,
            };
        })
    ),
    list: trpc.procedure.input(incidentPageSchema).query(({ ctx, input }) =>
        runOperation(async () => {
            const { operations } = authorizedOperations(ctx, "alerts:read");
            return operations.client.begin(async (transaction) => {
                await transaction`SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY`;
                const columns = transaction`id, name, host, service, severity, state, started_at::text AS "startedAt", to_char(resolved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "resolvedAt"`;
                const rows =
                    input.state === "resolved"
                        ? await transaction<
                              Incident[]
                          >`SELECT ${columns} FROM operational_incidents WHERE state = 'resolved' AND (${input.before?.id ?? null}::uuid IS NULL OR (resolved_at, id) < (${input.before?.resolvedAt ?? null}::timestamptz, ${input.before?.id ?? null}::uuid)) ORDER BY resolved_at DESC, id DESC LIMIT ${input.limit + 1}`
                        : await transaction<
                              Incident[]
                          >`SELECT ${columns} FROM operational_incidents WHERE state != 'resolved' AND (${input.before?.id ?? null}::uuid IS NULL OR id < ${input.before?.id ?? null}::uuid) ORDER BY id DESC LIMIT ${input.limit + 1}`;
                const [freshness] = await transaction<
                    { capturedAt: string; stale: boolean }[]
                >`SELECT captured_at::text AS "capturedAt", captured_at < now() - interval '3 minutes' AS stale FROM operation_snapshots WHERE key = 'alerts'`;
                const counts = await transaction<
                    { state: string; count: number }[]
                >`SELECT state, count(*)::int AS count FROM operational_incidents GROUP BY state`;
                const last = rows.at(input.limit - 1);
                return {
                    configured: Boolean(operations.alerts),
                    capturedAt: freshness?.capturedAt ?? null,
                    stale: freshness?.stale ?? true,
                    counts,
                    incidents: rows.slice(0, input.limit),
                    nextCursor:
                        rows.length > input.limit && last
                            ? {
                                  id: last.id,
                                  ...(input.state === "resolved" && last.resolvedAt
                                      ? { resolvedAt: last.resolvedAt }
                                      : {}),
                              }
                            : null,
                };
            });
        })
    ),
});
