import { historyRanges } from "@homelab/contracts/infrastructure";
import type { InfrastructureSnapshot } from "@homelab/contracts/operations";
import * as v from "valibot";

import { runOperation, trpc } from "../../api/trpc";
import { authorizedOperations } from "../../operations/authorization";
import { OperationFailure } from "../../operations/errors";
import type { OperationsRuntime } from "../../operations/runtime";
import { applicationHistoryExpressions } from "./applicationHistory";
import { collectHistory, collectMetricHistory } from "./history";
import { readSavedInventory } from "./snapshot";

const selectionSchema = v.strictObject({
    id: v.pipe(v.string(), v.minLength(1), v.maxLength(1024)),
    range: v.picklist(historyRanges),
    network: v.nullable(v.pipe(v.string(), v.maxLength(256))),
    disk: v.nullable(v.pipe(v.string(), v.maxLength(256))),
});

async function readInventory(operations: OperationsRuntime) {
    if (operations.readInventory) return operations.readInventory();
    return readSavedInventory(operations.client);
}

export const infrastructureRouter = trpc.router({
    applicationHistory: trpc.procedure
        .input((input) =>
            v.parse(
                v.strictObject({
                    id: v.pipe(v.string(), v.minLength(1), v.maxLength(1024)),
                    range: v.picklist(historyRanges),
                }),
                input
            )
        )
        .query(({ ctx, input, signal }) =>
            runOperation(async () => {
                const { operations } = authorizedOperations(ctx, "infrastructure:read");
                if (!operations.metrics)
                    throw new OperationFailure(
                        "PRECONDITION_FAILED",
                        "Historical metrics have not been configured."
                    );
                const inventory = await readInventory(operations);
                const application = inventory?.applications.find(
                    (item) => item.id === input.id
                );
                if (!application)
                    throw new OperationFailure(
                        "NOT_FOUND",
                        "This application is not in the latest inventory."
                    );
                const deadline = AbortSignal.timeout(15_000);
                return collectMetricHistory(
                    operations.metrics,
                    applicationHistoryExpressions(application),
                    input.range,
                    signal ? AbortSignal.any([signal, deadline]) : deadline,
                    {
                        cpu: "CPU",
                        memory: "Working set",
                        memoryCapacity: "Capacity",
                        receive: "Received",
                        transmit: "Sent",
                        read: "Read",
                        write: "Written",
                    }
                );
            })
        ),
    summary: trpc.procedure.query(({ ctx }) =>
        runOperation(async () => {
            const { operations } = authorizedOperations(ctx, "infrastructure:read");
            const rows = await operations.client<
                { value: InfrastructureSnapshot }[]
            >`SELECT value FROM operation_snapshots WHERE key = 'infrastructure'`;
            return rows[0]?.value ?? null;
        })
    ),
    inventory: trpc.procedure.query(({ ctx }) =>
        runOperation(async () => {
            const { operations } = authorizedOperations(ctx, "infrastructure:read");
            return readInventory(operations);
        })
    ),
    history: trpc.procedure
        .input((input) => v.parse(selectionSchema, input))
        .query(({ ctx, input, signal }) =>
            runOperation(async () => {
                const { operations } = authorizedOperations(ctx, "infrastructure:read");
                if (!operations.metrics)
                    throw new OperationFailure(
                        "PRECONDITION_FAILED",
                        "Historical metrics have not been configured."
                    );
                const inventory = await readInventory(operations);
                const host = inventory?.hosts.find((item) => item.id === input.id);
                if (!inventory || !host)
                    throw new OperationFailure(
                        "NOT_FOUND",
                        "This host is not in the latest inventory."
                    );
                if (
                    (input.network !== null &&
                        !inventory.networks.some(
                            (item) =>
                                item.host === host.host && item.device === input.network
                        )) ||
                    (input.disk !== null &&
                        !inventory.disks.some(
                            (item) =>
                                item.host === host.host && item.device === input.disk
                        ))
                )
                    throw new OperationFailure(
                        "BAD_REQUEST",
                        "Select a device from this host's inventory."
                    );
                const deadline = AbortSignal.timeout(15_000);
                return collectHistory(
                    operations.metrics,
                    { host, network: input.network, disk: input.disk },
                    input.range,
                    signal ? AbortSignal.any([signal, deadline]) : deadline
                );
            })
        ),
});
