import * as v from "valibot";

import { idSchema } from "./operations";

export const notificationSeverities = ["info", "success", "warning", "error"] as const;
export const notificationSeveritySchema = v.picklist(notificationSeverities);
export const notificationDestinationSchema = v.picklist([
    "jobs",
    "applications",
    "infrastructure",
]);
const boundedText = (maximum: number) =>
    v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(maximum));

export const publishNotificationSchema = v.strictObject({
    key: boundedText(160),
    title: boundedText(160),
    message: boundedText(2000),
    severity: notificationSeveritySchema,
    destination: v.optional(notificationDestinationSchema),
});
export const notificationFilterSchema = v.strictObject({
    state: v.optional(v.picklist(["all", "unread", "read"]), "all"),
    severity: v.optional(notificationSeveritySchema),
});
export const notificationPageSchema = v.strictObject({
    ...notificationFilterSchema.entries,
    before: v.optional(idSchema),
    limit: v.optional(
        v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(100)),
        30
    ),
});
export const notificationBulkSchema = v.strictObject({
    ...v.omit(notificationFilterSchema, ["state"]).entries,
    through: idSchema,
    action: v.picklist(["read", "dismissRead"]),
});

export type NotificationSeverity = v.InferOutput<typeof notificationSeveritySchema>;
export type NotificationDestination = v.InferOutput<typeof notificationDestinationSchema>;
export type PublishNotification = v.InferOutput<typeof publishNotificationSchema>;
export type NotificationFilter = v.InferOutput<typeof notificationFilterSchema>;
export type NotificationPageInput = v.InferOutput<typeof notificationPageSchema>;
export type NotificationBulkInput = v.InferOutput<typeof notificationBulkSchema>;

export interface NotificationRecord {
    readonly id: string;
    readonly source: string;
    readonly title: string;
    readonly message: string;
    readonly severity: NotificationSeverity;
    readonly destination: NotificationDestination | null;
    readonly createdAt: string;
    readonly readAt: string | null;
}

export interface NotificationPage {
    readonly notifications: NotificationRecord[];
    readonly nextCursor: string | null;
    readonly unreadCount: number;
    readonly readCount: number;
    readonly through: string | null;
}
