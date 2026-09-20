import { updateReportSchema, updateListSchema } from "@homelab/contracts/updates";

import { runOperation, trpc } from "../../api/trpc";
import { authorizedOperations } from "../../operations/authorization";
import { OperationFailure } from "../../operations/errors";
import { readUpdateSources, readUpdateReport, staleUpdateReport } from "./inventory";

export const updatesRouter = trpc.router({
    inventory: trpc.procedure.query(({ ctx }) =>
        runOperation(async () => {
            const { operations } = authorizedOperations(ctx, "updates:read");
            return readUpdateSources(operations.client, operations.updateSources ?? []);
        })
    ),
    list: trpc.procedure.input(updateListSchema).query(({ ctx, input }) =>
        runOperation(async () => {
            const { operations } = authorizedOperations(ctx, "updates:read");
            if (!operations.updateSources?.some((source) => source.id === input.source))
                throw new OperationFailure(
                    "NOT_FOUND",
                    "This update source is not configured."
                );
            const report = await readUpdateReport(operations.client, input.source);
            const stale = staleUpdateReport(report);
            const matches = (report?.items ?? [])
                .filter(
                    (item) =>
                        (input.state === "all" || item.status !== "current" || stale) &&
                        item.name.toLowerCase().includes(input.search.toLowerCase()) &&
                        (!input.after || item.id > input.after)
                )
                .toSorted((left, right) => (left.id < right.id ? -1 : 1));
            const items = matches.slice(0, input.limit);
            return {
                items,
                stale,
                nextCursor:
                    matches.length > input.limit ? (items.at(-1)?.id ?? null) : null,
            };
        })
    ),
    publish: trpc.procedure.input(updateReportSchema).mutation(({ ctx, input }) =>
        runOperation(async () => {
            const { operations, principal } = authorizedOperations(
                ctx,
                "updates:publish"
            );
            if (principal.kind !== "automation")
                throw new OperationFailure(
                    "FORBIDDEN",
                    "Update reports require a scoped automation account."
                );
            const sources = (operations.updateSources ?? []).filter(
                (source) => source.publisher === principal.id
            );
            const source = sources.length === 1 ? sources[0] : undefined;
            if (!source)
                throw new OperationFailure(
                    "FORBIDDEN",
                    "This account is not registered as an update source."
                );
            const time = Date.parse(input.capturedAt);
            if (
                time > Date.now() + 60_000 ||
                time < Date.now() - 3_600_000 ||
                (input.repositoryMetadataAt !== null &&
                    Date.parse(input.repositoryMetadataAt) > time + 60_000) ||
                new Set(input.items.map((item) => item.id)).size !== input.items.length ||
                input.items.some((item) => !input.coveredKinds.includes(item.kind))
            )
                throw new OperationFailure(
                    "BAD_REQUEST",
                    "Update report timestamps or item identities are invalid."
                );
            const [row] = await operations.client<
                { key: string }[]
            >`INSERT INTO operation_snapshots (key, value, captured_at) VALUES (${`updates:${source.id}`}, ${JSON.stringify(input)}::text::jsonb, ${new Date(time)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, captured_at = EXCLUDED.captured_at WHERE operation_snapshots.captured_at < EXCLUDED.captured_at RETURNING key`;
            return { accepted: Boolean(row) };
        })
    ),
});
