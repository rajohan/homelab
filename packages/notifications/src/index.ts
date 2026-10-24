import {
    publishNotificationSchema,
    type PublishNotification,
} from "@homelab/contracts/notifications";
import type { TransactionSQL } from "bun";
import * as v from "valibot";

/** A producer tried to reuse a durable notification key for different content. */
export class NotificationConflict extends Error {
    /** Create a safe conflict without exposing the existing notification. */
    constructor() {
        super("This notification key already identifies different content.");
        this.name = "NotificationConflict";
    }
}

/**
 * Publish an immutable notification in commit order within a server-owned namespace.
 * @param transaction - Active transaction; publication commits with its producer.
 * @param source - Server-verified producer identity, not a model-supplied label.
 * @param input - Validated plain-text content and an internal destination.
 * @param recipient - Optional verified actor; null retains the shared operator inbox.
 * @returns The existing or new identity; conflicting replays are rejected.
 */
export async function publishNotification(
    transaction: TransactionSQL,
    source: string,
    input: PublishNotification,
    recipient: string | null = null
): Promise<string> {
    const value = v.parse(publishNotificationSchema, input);
    if (!/^[a-zA-Z0-9:._-]{1,160}$/.test(source))
        throw new Error("Invalid notification producer");
    if (
        recipient !== null &&
        (!recipient.startsWith("human:") ||
            recipient.length > 1000 ||
            recipient.length === 6)
    )
        throw new Error("Invalid notification recipient");
    // Sequence allocation alone is not commit order. Keep this lock through commit.
    await transaction`SELECT pg_advisory_xact_lock(1869440354, 2)`;
    const inserted = await transaction<
        { id: string }[]
    >`INSERT INTO dashboard_notifications (id, source, source_key, title, message, severity, destination, recipient) VALUES (${Bun.randomUUIDv7()}, ${source}, ${value.key}, ${value.title}, ${value.message}, ${value.severity}, ${value.destination ?? null}, ${recipient}) ON CONFLICT (source, source_key) DO NOTHING RETURNING id`;
    if (inserted[0]) return inserted[0].id;
    const [existing] = await transaction<
        {
            id: string;
            title: string;
            message: string;
            severity: string;
            destination: string | null;
            recipient: string | null;
        }[]
    >`SELECT id, title, message, severity, destination, recipient FROM dashboard_notifications WHERE source = ${source} AND source_key = ${value.key}`;
    if (
        !existing ||
        existing.title !== value.title ||
        existing.message !== value.message ||
        existing.severity !== value.severity ||
        existing.destination !== (value.destination ?? null) ||
        existing.recipient !== recipient
    )
        throw new NotificationConflict();
    return existing.id;
}
