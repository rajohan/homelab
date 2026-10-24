import type { PublishNotification } from "@homelab/contracts/notifications";
import {
    NotificationConflict,
    publishNotification as persistNotification,
} from "@homelab/notifications";

import type { Transaction } from "../database/connection";
import { OperationFailure } from "../operations/errors";

/**
 * Persist a shared operator notification once within its producer's namespace.
 * @param transaction - Active dashboard transaction; publication commits with its producer.
 * @param source - Server-owned producer identity, never an untrusted display name.
 * @param input - Plain-text content and an optional internal destination.
 * @returns The existing or new ID; conflicting replay becomes a public conflict.
 */
export async function publishNotification(
    transaction: Transaction,
    source: string,
    input: PublishNotification
): Promise<string> {
    try {
        return await persistNotification(transaction, source, input);
    } catch (error) {
        if (error instanceof NotificationConflict)
            throw new OperationFailure("CONFLICT", error.message);
        throw error;
    }
}
