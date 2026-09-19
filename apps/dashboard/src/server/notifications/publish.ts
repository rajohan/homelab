import {
    publishNotificationSchema,
    type PublishNotification,
} from "@homelab/contracts/notifications";
import * as v from "valibot";

import type { Transaction } from "../database/connection";
import { OperationFailure } from "../operations/errors";

/**
 * Persist an immutable operator notification once within its producer's namespace.
 * @param transaction - Active dashboard transaction; publication commits with its producer.
 * @param source - Server-owned producer identity, never an untrusted display name.
 * @param input - Plain-text content and an optional internal destination.
 * @returns The existing or new notification ID; conflicting replay is rejected.
 */
export async function publishNotification(
    transaction: Transaction,
    source: string,
    input: PublishNotification
): Promise<string> {
    const value = v.parse(publishNotificationSchema, input);
    if (!/^[a-zA-Z0-9:._-]{1,160}$/.test(source))
        throw new Error("Invalid notification producer");
    // Sequence allocation alone is not commit order. Hold this database-local lock
    // until the producer commits so no later visible cursor can hide an older insert.
    await transaction`SELECT pg_advisory_xact_lock(1869440354, 2)`;
    const inserted = await transaction<
        { id: string }[]
    >`INSERT INTO dashboard_notifications (id, source, source_key, title, message, severity, destination) VALUES (${Bun.randomUUIDv7()}, ${source}, ${value.key}, ${value.title}, ${value.message}, ${value.severity}, ${value.destination ?? null}) ON CONFLICT (source, source_key) DO NOTHING RETURNING id`;
    if (inserted[0]) return inserted[0].id;
    const [existing] = await transaction<
        {
            id: string;
            title: string;
            message: string;
            severity: string;
            destination: string | null;
        }[]
    >`SELECT id, title, message, severity, destination FROM dashboard_notifications WHERE source = ${source} AND source_key = ${value.key}`;
    if (
        !existing ||
        existing.title !== value.title ||
        existing.message !== value.message ||
        existing.severity !== value.severity ||
        existing.destination !== (value.destination ?? null)
    )
        throw new OperationFailure(
            "CONFLICT",
            "This notification key already identifies different content."
        );
    return existing.id;
}
