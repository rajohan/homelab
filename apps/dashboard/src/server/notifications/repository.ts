import type {
    NotificationBulkInput,
    NotificationPage,
    NotificationPageInput,
    NotificationRecord,
} from "@homelab/contracts/notifications";
import { idSchema } from "@homelab/contracts/operations";
import type { SQL } from "bun";
import * as v from "valibot";

import {
    readRestartProgress,
    type RestartBatch,
} from "../integrations/maintenance/batch";
import { OperationFailure } from "../operations/errors";

const restartBatchKey = "restart-batch:";

function notificationJobRunId(source: string, key: string) {
    if (source === "jobs" && v.is(idSchema, key)) return key;
    if (source === "updates") {
        const [event, run] = key.split(":", 2);
        if ((event === "reboot" || event === "observation-failed") && v.is(idSchema, run))
            return run;
    }
    return null;
}

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
    return client.begin(
        "ISOLATION LEVEL REPEATABLE READ READ ONLY",
        async (transaction) => {
            const rows = await transaction<
                (NotificationRecord & { cursor: string; sourceKey: string })[]
            >`SELECT n.id, n.publication_order::text AS cursor, n.source, n.source_key AS "sourceKey", n.title, n.message, n.severity, n.destination, n.created_at::text AS "createdAt", r.read_at::text AS "readAt" FROM dashboard_notifications n LEFT JOIN notification_receipts r ON r.notification_id = n.id AND r.actor = ${actor} WHERE (n.recipient IS NULL OR n.recipient = ${actor}) AND r.dismissed_at IS NULL AND (${input.before ?? null}::bigint IS NULL OR n.publication_order < ${input.before ?? null}::bigint) AND (${input.severity ?? null}::text IS NULL OR n.severity = ${input.severity ?? null}) AND (${input.state} = 'all' OR (${input.state} = 'read' AND r.read_at IS NOT NULL) OR (${input.state} = 'unread' AND r.read_at IS NULL)) ORDER BY n.publication_order DESC LIMIT ${input.limit + 1}`;
            const [counts] = await transaction<
                { unreadCount: number; readCount: number; through: string | null }[]
            >`SELECT count(*) FILTER (WHERE r.read_at IS NULL)::int AS "unreadCount", count(*) FILTER (WHERE r.read_at IS NOT NULL)::int AS "readCount", max(n.publication_order)::text AS through FROM dashboard_notifications n LEFT JOIN notification_receipts r ON r.notification_id = n.id AND r.actor = ${actor} WHERE (n.recipient IS NULL OR n.recipient = ${actor}) AND r.dismissed_at IS NULL AND (${input.severity ?? null}::text IS NULL OR n.severity = ${input.severity ?? null})`;
            const notifications = rows.slice(0, input.limit);
            return {
                notifications: notifications.map(
                    ({ cursor: _cursor, sourceKey, ...notification }) => {
                        if (
                            notification.source === "maintenance" &&
                            notification.destination === "jobs" &&
                            notification.severity === "warning" &&
                            sourceKey.startsWith(restartBatchKey)
                        ) {
                            const restartBatchId = sourceKey.slice(
                                restartBatchKey.length
                            );
                            if (v.is(idSchema, restartBatchId))
                                return { ...notification, restartBatchId };
                        }
                        if (
                            notification.destination === "calendar" &&
                            notification.source === "calendar"
                        ) {
                            const [calendarEventId] = sourceKey.split(":");
                            if (v.is(idSchema, calendarEventId))
                                return { ...notification, calendarEventId };
                        }
                        const jobRunId =
                            notification.destination === "jobs"
                                ? notificationJobRunId(notification.source, sourceKey)
                                : undefined;
                        return jobRunId ? { ...notification, jobRunId } : notification;
                    }
                ),
                nextCursor:
                    rows.length > input.limit
                        ? (notifications.at(-1)?.cursor ?? null)
                        : null,
                unreadCount: counts?.unreadCount ?? 0,
                readCount: counts?.readCount ?? 0,
                through: counts?.through ?? null,
            };
        }
    );
}

/**
 * Read restart progress for an immutable maintenance warning visible to this recipient.
 * @param client - Dashboard notification and maintenance database.
 * @param actor - Authenticated notification reader with access to maintenance.
 * @param id - Validated batch UUID selected in the notification link.
 * @returns The selected batch's public progress or null when the warning or journal is absent.
 */
export async function notifiedRestartBatch(client: SQL, actor: string, id: string) {
    const [row] = await client<
        { value: RestartBatch }[]
    >`SELECT s.value FROM operation_snapshots s
        WHERE s.key = ${"maintenance.batch:" + id} AND EXISTS (
            SELECT 1 FROM dashboard_notifications n WHERE n.source = 'maintenance'
            AND n.source_key = ${restartBatchKey + id} AND n.severity = 'warning' AND n.destination = 'jobs'
            AND (n.recipient IS NULL OR n.recipient = ${actor}))`;
    return row ? readRestartProgress(client, row.value) : null;
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
    >`INSERT INTO notification_receipts (notification_id, actor, read_at, dismissed_at) SELECT id, ${actor}, CASE WHEN ${action} = 'read' THEN now() ELSE NULL END, CASE WHEN ${action} = 'dismiss' THEN now() ELSE NULL END FROM dashboard_notifications WHERE id = ${id} AND (recipient IS NULL OR recipient = ${actor}) ON CONFLICT (notification_id, actor) DO UPDATE SET read_at = CASE WHEN ${action} = 'read' THEN COALESCE(notification_receipts.read_at, now()) WHEN ${action} = 'unread' THEN NULL ELSE notification_receipts.read_at END, dismissed_at = CASE WHEN ${action} = 'dismiss' THEN COALESCE(notification_receipts.dismissed_at, now()) ELSE notification_receipts.dismissed_at END RETURNING notification_id`;
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
        >`SELECT n.id FROM dashboard_notifications n LEFT JOIN notification_receipts r ON r.notification_id = n.id AND r.actor = ${actor} WHERE (n.recipient IS NULL OR n.recipient = ${actor}) AND n.publication_order <= ${input.through}::bigint AND r.dismissed_at IS NULL AND (${input.severity ?? null}::text IS NULL OR n.severity = ${input.severity ?? null}) AND ((${input.action} = 'read' AND r.read_at IS NULL) OR (${input.action} = 'dismissRead' AND r.read_at IS NOT NULL)) ORDER BY n.publication_order DESC LIMIT 101 FOR UPDATE OF n`;
        const batch = rows.slice(0, 100);
        for (const { id } of batch) {
            await transaction`INSERT INTO notification_receipts (notification_id, actor, read_at, dismissed_at) VALUES (${id}, ${actor}, now(), CASE WHEN ${input.action} = 'dismissRead' THEN now() ELSE NULL END) ON CONFLICT (notification_id, actor) DO UPDATE SET read_at = COALESCE(notification_receipts.read_at, now()), dismissed_at = CASE WHEN ${input.action} = 'dismissRead' THEN now() ELSE notification_receipts.dismissed_at END`;
        }
        return { affected: batch.length, remaining: rows.length > batch.length };
    });
}
