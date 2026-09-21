import type { Capability } from "@homelab/contracts/operations";
import {
    updateReportSchema,
    updateListSchema,
    updateRequestSchema,
    updatePolicySchema,
    updateBatchScopeSchema,
    updateBatchRequestSchema,
} from "@homelab/contracts/updates";

import { runOperation, trpc } from "../../api/trpc";
import { requireCapability } from "../../automation/authentication";
import { authorizedOperations } from "../../operations/authorization";
import type { OperationsContext } from "../../operations/context";
import { OperationFailure } from "../../operations/errors";
import { sortedInventory } from "../../operations/sortedInventory";
import { requestUpdate } from "./actions";
import { readUpdateBatchPlan, requestUpdateBatch } from "./batch";
import { readUpdateSources, readUpdateReport, staleUpdateReport } from "./inventory";
import { readUpdatePolicies, writeUpdatePolicy } from "./policies";
import { recordRestartObservation } from "./restartObservation";
import { matchesUpdateTarget, updateControl } from "./selection";

async function verifyOperator(context: OperationsContext, capability: Capability) {
    const { principal } = authorizedOperations(context, capability);
    if (principal.kind !== "human" || !context.verifyHuman)
        throw new OperationFailure(
            "FORBIDDEN",
            "A recently verified operator is required."
        );
    const current = await context.verifyHuman();
    if (current.kind !== "human" || current.id !== principal.id)
        throw new OperationFailure("UNAUTHORIZED", "The signed-in account changed.");
    requireCapability(current, capability);
}

export const updatesRouter = trpc.router({
    batchPlan: trpc.procedure.input(updateBatchScopeSchema).query(({ ctx, input }) =>
        runOperation(async () => {
            const { operations } = authorizedOperations(ctx, "updates:read");
            return readUpdateBatchPlan(
                operations.client,
                operations.updateSources ?? [],
                operations.updateTargets ?? [],
                operations.registry,
                input.source
            );
        })
    ),
    batchRequest: trpc.procedure
        .input(updateBatchRequestSchema)
        .mutation(({ ctx, input }) =>
            runOperation(async () => {
                const { operations, principal } = authorizedOperations(
                    ctx,
                    "updates:apply"
                );
                requireCapability(principal, "jobs:run");
                if (principal.kind === "human")
                    await verifyOperator(ctx, "updates:apply");
                return requestUpdateBatch(
                    operations.client,
                    operations.updateSources ?? [],
                    operations.updateTargets ?? [],
                    operations.registry,
                    `${principal.kind}:${principal.id}`,
                    input
                );
            })
        ),
    policies: trpc.procedure.query(({ ctx }) =>
        runOperation(async () => {
            const { operations } = authorizedOperations(ctx, "updates:read");
            return readUpdatePolicies(operations.client, operations.updateTargets ?? []);
        })
    ),
    policy: trpc.procedure.input(updatePolicySchema).mutation(({ ctx, input }) =>
        runOperation(async () => {
            const { operations, principal } = authorizedOperations(
                ctx,
                "updates:configure"
            );
            await verifyOperator(ctx, "updates:configure");
            const target = operations.updateTargets?.find(
                (item) => item.id === input.target
            );
            if (!target)
                throw new OperationFailure(
                    "NOT_FOUND",
                    "This update target is not configured."
                );
            await writeUpdatePolicy(
                operations.client,
                target,
                `${principal.kind}:${principal.id}`,
                input
            );
            return { updated: true };
        })
    ),
    request: trpc.procedure.input(updateRequestSchema).mutation(({ ctx, input }) =>
        runOperation(async () => {
            const { operations, principal } = authorizedOperations(ctx, "updates:apply");
            requireCapability(principal, "jobs:run");
            if (principal.kind === "human") await verifyOperator(ctx, "updates:apply");
            const target = operations.updateTargets?.find(
                (item) => item.id === input.target
            );
            const handler = operations.registry.get(`updates.install.${input.target}`);
            if (!target || !handler)
                throw new OperationFailure(
                    "PRECONDITION_FAILED",
                    "This update target is not configured for installation."
                );
            return requestUpdate(
                operations.client,
                target,
                handler,
                `${principal.kind}:${principal.id}`,
                input
            );
        })
    ),
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
                        (input.category === "all" ||
                            (input.category === "toolchains") ===
                                (item.kind === "runtime")) &&
                        (input.state === "all" || item.status !== "current" || stale) &&
                        item.name.toLowerCase().includes(input.search.toLowerCase()) &&
                        (input.sort || !input.after || item.id > input.after)
                )
                .toSorted((left, right) => (left.id < right.id ? -1 : 1));
            const sorted = input.sort
                ? sortedInventory(
                      matches,
                      {
                          name: (item) => item.name,
                          kind: (item) => item.kind,
                          installed: (item) => item.installed,
                          available: (item) => item.available,
                          status: (item) => (stale ? null : item.status),
                      },
                      input.sort,
                      input.cursor,
                      input.limit
                  )
                : null;
            const items = sorted?.items ?? matches.slice(0, input.limit);
            return {
                items: items.map((item) => {
                    const targets = (operations.updateTargets ?? []).filter(
                        (target) =>
                            target.source === input.source &&
                            matchesUpdateTarget(target, item)
                    );
                    return {
                        ...item,
                        control:
                            report && targets.length === 1 && targets[0]
                                ? updateControl(targets[0], report, item)
                                : null,
                    };
                }),
                stale,
                nextSortCursor: sorted?.nextSortCursor ?? null,
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
                (input.rebootObservedAt !== undefined &&
                    (Date.parse(input.rebootObservedAt) > time ||
                        Date.parse(input.rebootObservedAt) < time - 60_000)) ||
                (input.repositoryMetadataAt !== null &&
                    Date.parse(input.repositoryMetadataAt) > time + 60_000) ||
                new Set(input.items.map((item) => item.id)).size !== input.items.length ||
                input.items.some((item) => !input.coveredKinds.includes(item.kind))
            )
                throw new OperationFailure(
                    "BAD_REQUEST",
                    "Update report timestamps or item identities are invalid."
                );
            const observation = {
                ...input,
                items: input.items.map((item) => {
                    const {
                        availableImage: _image,
                        installedVersion: _installed,
                        availableVersion: _version,
                        candidateVerified: _verified,
                        ...software
                    } = item;
                    return software;
                }),
            };
            return operations.client.begin(async (transaction) => {
                const [row] = await transaction<
                    { key: string }[]
                >`INSERT INTO operation_snapshots (key, value, captured_at) VALUES (${`updates:${source.id}`}, ${JSON.stringify(observation)}::text::jsonb, ${new Date(time)}) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, captured_at = EXCLUDED.captured_at WHERE operation_snapshots.captured_at < EXCLUDED.captured_at RETURNING key`;
                if (row && input.rebootRequired !== undefined) {
                    const observedAt = input.rebootObservedAt ?? input.capturedAt;
                    await recordRestartObservation(
                        transaction,
                        source.id,
                        input.rebootRequired,
                        observedAt
                    );
                }
                return { accepted: Boolean(row) };
            });
        })
    ),
});
