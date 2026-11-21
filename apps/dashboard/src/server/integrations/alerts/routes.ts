import {
    type Incident,
    incidentPageSchema,
    type RuleInventory,
} from "@homelab/contracts/alerts";
import { idSchema } from "@homelab/contracts/operations";
import * as v from "valibot";

import { runOperation, trpc } from "../../api/trpc";
import { authorizedOperations } from "../../operations/authorization";
import { sortedPage } from "../../operations/sortedPage";

export const alertsRouter = trpc.router({
    occurrence: trpc.procedure
        .input(
            v.strictObject({
                kind: v.picklist(["incident", "notification"]),
                id: idSchema,
            })
        )
        .query(({ ctx, input }) =>
            runOperation(async () => {
                const { operations, principal } = authorizedOperations(
                    ctx,
                    "alerts:read"
                );
                const sql = operations.client;
                let occurrence = sql`i.id = ${input.id}`;
                if (input.kind === "notification") {
                    authorizedOperations(ctx, "notifications:read");
                    const actor = `${principal.kind}:${principal.id}`;
                    occurrence = sql`i.source_key = (
                        SELECT regexp_replace(n.source_key, ':(opened|resolved)$', '')
                        FROM dashboard_notifications n
                        WHERE n.id = ${input.id} AND n.source = 'alerts' AND n.destination = 'alerts'
                        AND n.source_key ~ ':(opened|resolved)$' AND (n.recipient IS NULL OR n.recipient = ${actor})
                    )`;
                }
                const [row] = await sql<
                    Incident[]
                >`SELECT i.id, i.name, i.host, i.service, i.severity, i.state,
                    i.started_at::text AS "startedAt", i.resolved_at::text AS "resolvedAt"
                    FROM operational_incidents i WHERE ${occurrence}`;
                return row ?? null;
            })
        ),
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
                const sorted = input.sort
                    ? await sortedPage<Incident>(
                          transaction,
                          transaction`SELECT ${columns}, concat_ws(' ', host, service) AS "hostService" FROM operational_incidents WHERE (${input.state} = 'resolved' AND state = 'resolved') OR (${input.state} = 'current' AND state != 'resolved')`,
                          {
                              name: "name",
                              host: "hostService",
                              state: "state",
                              time:
                                  input.state === "resolved" ? "resolvedAt" : "startedAt",
                          },
                          input.sort,
                          input.cursor,
                          input.limit
                      )
                    : null;
                let rows: Incident[];
                if (sorted) rows = sorted.items;
                else if (input.state === "resolved")
                    rows = await transaction<
                        Incident[]
                    >`SELECT ${columns} FROM operational_incidents WHERE state = 'resolved' AND (${input.before?.id ?? null}::uuid IS NULL OR (resolved_at, id) < (${input.before?.resolvedAt ?? null}::timestamptz, ${input.before?.id ?? null}::uuid)) ORDER BY resolved_at DESC, id DESC LIMIT ${input.limit + 1}`;
                else
                    rows = await transaction<
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
                    nextSortCursor: sorted?.nextSortCursor ?? null,
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
