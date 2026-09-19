import { applicationLogsSchema } from "@homelab/contracts/logs";

import { runOperation, trpc } from "../../api/trpc";
import { authorizedOperations } from "../../operations/authorization";
import { OperationFailure } from "../../operations/errors";
import { readApplicationInventory } from "../applications/selection";
import { readApplicationLogs } from "./transport";

export const applicationLogsProcedure = trpc.procedure
    .input(applicationLogsSchema)
    .query(({ ctx, input, signal }) =>
        runOperation(async () => {
            const { operations } = authorizedOperations(ctx, "applications:logs");
            const target = operations.applicationTargets?.find(
                (host) => host.id === input.host
            );
            if (!target?.logs || !operations.logs)
                throw new OperationFailure(
                    "PRECONDITION_FAILED",
                    "Application logs have not been configured."
                );
            const snapshot = await readApplicationInventory(operations.client);
            const application = snapshot?.inventory.hosts
                .find((host) => host.id === input.host)
                ?.applications.find(
                    (item) =>
                        item.containerId === input.container &&
                        target.projects.includes(item.project)
                );
            if (!application)
                throw new OperationFailure(
                    "NOT_FOUND",
                    "This application is not in the managed inventory."
                );
            return readApplicationLogs(
                operations.logs,
                {
                    ...target.logs.labels,
                    [target.logs.serviceLabel]:
                        target.logs.servicePrefix + application.containerName,
                },
                input,
                AbortSignal.any([
                    ...(signal ? [signal] : []),
                    AbortSignal.timeout(10_000),
                ])
            );
        })
    );
