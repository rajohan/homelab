import {
    notificationBulkSchema,
    notificationPageSchema,
    publishNotificationSchema,
} from "@homelab/contracts/notifications";
import { idSchema } from "@homelab/contracts/operations";
import * as v from "valibot";

import { runOperation, trpc } from "../api/trpc";
import { authorizedOperations } from "../operations/authorization";
import type { OperationsContext } from "../operations/context";
import { OperationFailure } from "../operations/errors";
import { publishNotification } from "./publish";
import {
    acknowledgeNotification,
    acknowledgeNotificationBatch,
    listNotifications,
} from "./repository";

function humanInbox(context: OperationsContext) {
    const { operations, principal } = authorizedOperations(context, "notifications:read");
    if (principal.kind !== "human")
        throw new OperationFailure(
            "FORBIDDEN",
            "Only a signed-in operator can acknowledge notifications."
        );
    return { client: operations.client, actor: `human:${principal.id}` };
}

export const notificationsRouter = trpc.router({
    list: trpc.procedure.input(notificationPageSchema).query(({ ctx, input }) =>
        runOperation(async () => {
            const { operations, principal } = authorizedOperations(
                ctx,
                "notifications:read"
            );
            return listNotifications(
                operations.client,
                `${principal.kind}:${principal.id}`,
                input
            );
        })
    ),
    publish: trpc.procedure.input(publishNotificationSchema).mutation(({ ctx, input }) =>
        runOperation(async () => {
            const { operations, principal } = authorizedOperations(
                ctx,
                "notifications:publish"
            );
            if (principal.kind !== "automation")
                throw new OperationFailure(
                    "FORBIDDEN",
                    "Only an authorized automation account can publish external notifications."
                );
            return {
                id: await publishNotification(
                    operations.client,
                    `automation:${principal.id}`,
                    input
                ),
            };
        })
    ),
    acknowledge: trpc.procedure
        .input(
            v.strictObject({
                id: idSchema,
                action: v.picklist(["read", "unread", "dismiss"]),
            })
        )
        .mutation(({ ctx, input }) =>
            runOperation(async () => {
                const { client, actor } = humanInbox(ctx);
                await acknowledgeNotification(client, actor, input.id, input.action);
                return { ok: true };
            })
        ),
    acknowledgeBatch: trpc.procedure
        .input(notificationBulkSchema)
        .mutation(({ ctx, input }) =>
            runOperation(async () => {
                const { client, actor } = humanInbox(ctx);
                return acknowledgeNotificationBatch(client, actor, input);
            })
        ),
});
