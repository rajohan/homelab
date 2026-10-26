import { miraComputerPairSchema } from "@homelab/contracts/miraComputers";
import { versionedIdSchema } from "@homelab/contracts/operations";
import {
    createMiraComputerPairing,
    listMiraComputers,
    revokeMiraComputer,
} from "@homelab/mira/data/computers";
import { MiraFailure, type MiraContext } from "@homelab/mira/data/context";

import { runOperation, trpc } from "../api/trpc";
import {
    authorizeAutomationAdministration,
    authorizedOperations,
} from "../operations/authorization";
import type { OperationsContext } from "../operations/context";
import { OperationFailure } from "../operations/errors";

function execute<T>(
    context: OperationsContext,
    mutation: boolean,
    operation: (mira: MiraContext) => Promise<T>
) {
    return runOperation(async () => {
        const { operations, principal } = authorizedOperations(context, "jobs:read");
        if (principal.kind !== "human")
            throw new OperationFailure(
                "FORBIDDEN",
                "Computer pairing requires a signed-in operator."
            );
        if (mutation) await authorizeAutomationAdministration(context);
        try {
            return await operation({
                client: operations.client,
                owner: principal.id,
                actor: `human:${principal.id}`,
            });
        } catch (error) {
            if (error instanceof MiraFailure)
                throw new OperationFailure(error.code, error.message);
            throw error;
        }
    });
}

export const miraComputerRouter = trpc.router({
    list: trpc.procedure.query(({ ctx }) => execute(ctx, false, listMiraComputers)),
    pair: trpc.procedure
        .input(miraComputerPairSchema)
        .mutation(({ ctx, input }) =>
            execute(ctx, true, (mira) => createMiraComputerPairing(mira, input))
        ),
    revoke: trpc.procedure
        .input(versionedIdSchema)
        .mutation(({ ctx, input }) =>
            execute(ctx, true, (mira) => revokeMiraComputer(mira, input))
        ),
});
