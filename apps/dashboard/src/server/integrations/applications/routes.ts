import { applicationIntentSchema } from "@homelab/contracts/applications";

import { runOperation, trpc } from "../../api/trpc";
import { requireCapability } from "../../automation/authentication";
import { enqueueJob, lockQueue } from "../../jobs/queue";
import { authorizedOperations } from "../../operations/authorization";
import { OperationFailure } from "../../operations/errors";
import { applicationLogsProcedure } from "../logs/routes";
import { filterApplicationInventory } from "./inventory";
import {
    readApplicationInventory,
    selectApplications,
    selectionRevision,
} from "./selection";

export const applicationsRouter = trpc.router({
    logs: applicationLogsProcedure,
    inventory: trpc.procedure.query(({ ctx }) =>
        runOperation(async () => {
            const { operations } = authorizedOperations(ctx, "applications:read");
            const targets = operations.applicationTargets ?? [];
            const inventory = filterApplicationInventory(
                await readApplicationInventory(operations.client),
                targets
            );
            return {
                configured: targets.length > 0,
                inventory,
                logHosts: operations.logs
                    ? targets.filter((target) => target.logs).map((target) => target.id)
                    : [],
                projects:
                    inventory?.hosts.flatMap((host) =>
                        [...new Set(host.applications.map((item) => item.project))].map(
                            (name) => ({
                                host: host.id,
                                name,
                                revision: selectionRevision(
                                    host.applications.filter(
                                        (item) => item.project === name
                                    ),
                                    { kind: "project", target: name }
                                ),
                            })
                        )
                    ) ?? [],
            };
        })
    ),
    request: trpc.procedure.input(applicationIntentSchema).mutation(({ ctx, input }) =>
        runOperation(async () => {
            const { operations, principal } = authorizedOperations(
                ctx,
                `applications:${input.operation}`
            );
            requireCapability(principal, "jobs:run");
            if (principal.kind === "human") {
                if (!ctx.verifyHuman)
                    throw new OperationFailure(
                        "FORBIDDEN",
                        "Recent verification is required."
                    );
                const current = await ctx.verifyHuman();
                if (current.kind !== "human" || current.id !== principal.id)
                    throw new OperationFailure(
                        "UNAUTHORIZED",
                        "The signed-in account changed."
                    );
                requireCapability(current, `applications:${input.operation}`);
            }
            const definition = operations.registry.get(
                `applications.${input.operation}`
            )?.definition;
            if (
                !definition ||
                !operations.applicationTargets?.some((target) => target.id === input.host)
            )
                throw new OperationFailure(
                    "PRECONDITION_FAILED",
                    "This application host is not configured for control."
                );
            const { requestId, ...payload } = input;
            const key = `${principal.kind}:${principal.id}:${requestId}`;
            return operations.client.begin(async (transaction) => {
                await lockQueue(transaction);
                const [existing] = await transaction<
                    { id: string }[]
                >`SELECT id FROM job_runs WHERE idempotency_key=${key}`;
                let label = definition.label;
                if (!existing) {
                    const inventory = filterApplicationInventory(
                        await readApplicationInventory(transaction),
                        operations.applicationTargets ?? []
                    );
                    const selected = selectApplications(
                        inventory,
                        input.host,
                        input.selection
                    );
                    if (selectionRevision(selected, input.selection) !== input.revision)
                        throw new OperationFailure(
                            "CONFLICT",
                            "Application state changed. Refresh and confirm the current selection."
                        );
                    const name =
                        input.selection.kind === "project"
                            ? input.selection.target
                            : (selected[0]?.name ?? input.selection.target);
                    const verbs = { start: "Start", stop: "Stop", restart: "Restart" };
                    label = `${verbs[input.operation]} ${name}`;
                }
                return {
                    id: await enqueueJob(
                        transaction,
                        definition,
                        `${principal.kind}:${principal.id}`,
                        key,
                        payload,
                        label
                    ),
                };
            });
        })
    ),
});
