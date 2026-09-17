import {
    createAutomationSchema,
    idSchema,
    pageSchema,
    updateAutomationSchema,
    versionedIdSchema,
} from "@homelab/contracts/operations";
import * as v from "valibot";

import { runOperation, trpc } from "../api/trpc";
import {
    authorizeAutomationAdministration,
    authorizedOperations,
} from "../operations/authorization";
import { OperationFailure } from "../operations/errors";
import {
    changeAutomation,
    createAutomation,
    listAutomation,
    rotateAutomation,
} from "./service";

export const automationRouter = trpc.router({
    list: trpc.procedure.input(pageSchema).query(({ ctx, input }) =>
        runOperation(async () => {
            const { operations, principal } = authorizedOperations(ctx, "jobs:read");
            if (principal.kind !== "human")
                throw new OperationFailure(
                    "FORBIDDEN",
                    "Only the operator can view automation access."
                );
            return listAutomation(operations.client, input.before);
        })
    ),
    create: trpc.procedure.input(createAutomationSchema).mutation(({ ctx, input }) =>
        runOperation(async () => {
            const { client, actor } = await authorizeAutomationAdministration(ctx);
            return createAutomation(client, actor, input);
        })
    ),
    rotate: trpc.procedure
        .input(
            v.strictObject({
                ...versionedIdSchema.entries,
                expiresAt: createAutomationSchema.entries.expiresAt,
            })
        )
        .mutation(({ ctx, input }) =>
            runOperation(async () => {
                const { client, actor } = await authorizeAutomationAdministration(ctx);
                return rotateAutomation(client, actor, input);
            })
        ),
    permissions: trpc.procedure.input(updateAutomationSchema).mutation(({ ctx, input }) =>
        runOperation(async () => {
            const { client, actor } = await authorizeAutomationAdministration(ctx);
            await changeAutomation(client, actor, { ...input, kind: "capabilities" });
            return { ok: true };
        })
    ),
    revoke: trpc.procedure
        .input(v.strictObject({ ...versionedIdSchema.entries, credentialId: idSchema }))
        .mutation(({ ctx, input }) =>
            runOperation(async () => {
                const { client, actor } = await authorizeAutomationAdministration(ctx);
                await changeAutomation(client, actor, { ...input, kind: "revoke" });
                return { ok: true };
            })
        ),
    disable: trpc.procedure.input(versionedIdSchema).mutation(({ ctx, input }) =>
        runOperation(async () => {
            const { client, actor } = await authorizeAutomationAdministration(ctx);
            await changeAutomation(client, actor, { ...input, kind: "disable" });
            return { ok: true };
        })
    ),
});
