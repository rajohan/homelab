import type {
    NotificationBulkInput,
    NotificationPage,
    NotificationPageInput,
    NotificationRecord,
} from "@homelab/contracts/notifications";
import type { SQL } from "bun";

import { OperationFailure } from "../operations/errors";

/**
 * Read a stable cursor page with personal read state and filtered counts.
 * @param client - Dashboard database, never the identity database.
 * @param actor - Authenticated reader identity; receipts are isolated per operator.
 * @param input - Validated filters and bounded cursor.
 * @returns Plain-text notifications, counts and a fixed upper bound for bulk actions.
 */
export async function listNotifications(
    client: SQL,
    actor: string,
    input: NotificationPageInput
): Promise<NotificationPage> {
    const rows = await client<
        NotificationRecord[]
    >`SELECT n.id, n.source, n.title, n.message, n.severity, n.destination, n.created_at::text AS "createdAt", r.read_at::text AS "readAt" FROM dashboard_notifications n LEFT JOIN notification_receipts r ON r.notification_id = n.id AND r.actor = ${actor} WHERE r.dismissed_at IS NULL AND (${input.before ?? null}::uuid IS NULL OR n.id < ${input.before ?? null}::uuid) AND (${input.severity ?? null}::text IS NULL OR n.severity = ${input.severity ?? null}) AND (${input.state} = 'all' OR (${input.state} = 'read' AND r.read_at IS NOT NULL) OR (${input.state} = 'unread' AND r.read_at IS NULL)) ORDER BY n.id DESC LIMIT ${input.limit + 1}`;
    const [counts] = await client<
        { unreadCount: number; readCount: number; through: string | null }[]
    >`SELECT count(*) FILTER (WHERE r.read_at IS NULL)::int AS "unreadCount", count(*) FILTER (WHERE r.read_at IS NOT NULL)::int AS "readCount", max(n.id::text) AS through FROM dashboard_notifications n LEFT JOIN notification_receipts r ON r.notification_id = n.id AND r.actor = ${actor} WHERE r.dismissed_at IS NULL AND (${input.severity ?? null}::text IS NULL OR n.severity = ${input.severity ?? null})`;
    const notifications = rows.slice(0, input.limit);
    return {
        notifications,
        nextCursor: rows.length > input.limit ? (notifications.at(-1)?.id ?? null) : null,
        unreadCount: counts?.unreadCount ?? 0,
        readCount: counts?.readCount ?? 0,
        through: counts?.through ?? null,
    };
}

/**
 * Change only the current operator's acknowledgement, never another reader's state.
 * @param client - Dashboard database connection.
 * @param actor - Verified human identity.
 * @param id - Exact notification identity.
 * @param action - Mark read/unread or dismiss from this operator's inbox.
 * @returns Completion after an idempotent acknowledgement.
 */
export async function acknowledgeNotification(
    client: SQL,
    actor: string,
    id: string,
    action: "read" | "unread" | "dismiss"
): Promise<void> {
    const rows = await client<
        { notification_id: string }[]
    >`INSERT INTO notification_receipts (notification_id, actor, read_at, dismissed_at) SELECT id, ${actor}, CASE WHEN ${action} = 'read' THEN now() ELSE NULL END, CASE WHEN ${action} = 'dismiss' THEN now() ELSE NULL END FROM dashboard_notifications WHERE id = ${id} ON CONFLICT (notification_id, actor) DO UPDATE SET read_at = CASE WHEN ${action} = 'read' THEN COALESCE(notification_receipts.read_at, now()) WHEN ${action} = 'unread' THEN NULL ELSE notification_receipts.read_at END, dismissed_at = CASE WHEN ${action} = 'dismiss' THEN COALESCE(notification_receipts.dismissed_at, now()) ELSE notification_receipts.dismissed_at END RETURNING notification_id`;
    if (rows.length === 0)
        throw new OperationFailure("NOT_FOUND", "This notification no longer exists.");
}

/**
 * Acknowledge one bounded batch without touching notifications arriving after confirmation.
 * @param client - Dashboard database connection.
 * @param actor - Verified human identity.
 * @param input - Fixed upper cursor, severity filter and action.
 * @returns Batch size and whether another bounded request may be needed.
 */
export async function acknowledgeNotificationBatch(
    client: SQL,
    actor: string,
    input: NotificationBulkInput
) {
    return client.begin(async (transaction) => {
        const rows = await transaction<
            { id: string }[]
        >`SELECT n.id FROM dashboard_notifications n LEFT JOIN notification_receipts r ON r.notification_id = n.id AND r.actor = ${actor} WHERE n.id <= ${input.through} AND r.dismissed_at IS NULL AND (${input.severity ?? null}::text IS NULL OR n.severity = ${input.severity ?? null}) AND ((${input.action} = 'read' AND r.read_at IS NULL) OR (${input.action} = 'dismissRead' AND r.read_at IS NOT NULL)) ORDER BY n.id DESC LIMIT 100 FOR UPDATE OF n`;
        for (const { id } of rows) {
            await transaction`INSERT INTO notification_receipts (notification_id, actor, read_at, dismissed_at) VALUES (${id}, ${actor}, now(), CASE WHEN ${input.action} = 'dismissRead' THEN now() ELSE NULL END) ON CONFLICT (notification_id, actor) DO UPDATE SET read_at = COALESCE(notification_receipts.read_at, now()), dismissed_at = CASE WHEN ${input.action} = 'dismissRead' THEN now() ELSE notification_receipts.dismissed_at END`;
        }
        return { affected: rows.length, remaining: rows.length === 100 };
    });
}
