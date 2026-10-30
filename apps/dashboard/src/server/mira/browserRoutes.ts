import {
    miraBrowserConsoleSchema,
    miraBrowserTransferSchema,
    miraBrowserHumanCommandSchema,
    miraBrowserAccessListSchema,
    miraBrowserAccessRequestSchema,
    miraBrowserAccessStopSchema,
    miraBrowserProfileCreateSchema,
    miraBrowserProfileDeleteSchema,
} from "@homelab/contracts/miraBrowser";
import {
    listMiraBrowserAccess,
    requestMiraBrowserAccess,
    stopMiraBrowserAccess,
} from "@homelab/mira/data/browserAccess";
import {
    readMiraBrowserConsole,
    transferMiraBrowserControl,
    enqueueMiraBrowserHumanCommand,
} from "@homelab/mira/data/browserConsole";
import {
    listMiraBrowserProfiles,
    createMiraBrowserProfile,
    deleteMiraBrowserProfile,
} from "@homelab/mira/data/browserProfiles";
import { listMiraBrowserUploads } from "@homelab/mira/data/browserUploads";
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
                "Browser access requires a signed-in operator."
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

export const miraBrowserRouter = trpc.router({
    profiles: trpc.procedure.query(({ ctx }) =>
        execute(ctx, false, listMiraBrowserProfiles)
    ),
    createProfile: trpc.procedure
        .input(miraBrowserProfileCreateSchema)
        .mutation(({ ctx, input }) =>
            execute(ctx, true, (mira) => createMiraBrowserProfile(mira, input))
        ),
    deleteProfile: trpc.procedure
        .input(miraBrowserProfileDeleteSchema)
        .mutation(({ ctx, input }) =>
            execute(ctx, true, (mira) => deleteMiraBrowserProfile(mira, input))
        ),
    uploads: trpc.procedure
        .input(miraBrowserConsoleSchema)
        .query(({ ctx, input }) =>
            execute(ctx, false, (mira) => listMiraBrowserUploads(mira, input))
        ),
    console: trpc.procedure
        .input(miraBrowserConsoleSchema)
        .query(({ ctx, input }) =>
            execute(ctx, false, (mira) => readMiraBrowserConsole(mira, input))
        ),
    transfer: trpc.procedure
        .input(miraBrowserTransferSchema)
        .mutation(({ ctx, input }) =>
            execute(ctx, true, (mira) => transferMiraBrowserControl(mira, input))
        ),
    command: trpc.procedure
        .input(miraBrowserHumanCommandSchema)
        .mutation(({ ctx, input }) =>
            execute(ctx, true, (mira) => enqueueMiraBrowserHumanCommand(mira, input))
        ),
    list: trpc.procedure
        .input(miraBrowserAccessListSchema)
        .query(({ ctx, input }) =>
            execute(ctx, false, (mira) => listMiraBrowserAccess(mira, input?.runId))
        ),
    request: trpc.procedure
        .input(miraBrowserAccessRequestSchema)
        .mutation(({ ctx, input }) =>
            execute(ctx, true, (mira) => requestMiraBrowserAccess(mira, input))
        ),
    stop: trpc.procedure
        .input(miraBrowserAccessStopSchema)
        .mutation(({ ctx, input }) =>
            execute(ctx, false, (mira) => stopMiraBrowserAccess(mira, input))
        ),
});
