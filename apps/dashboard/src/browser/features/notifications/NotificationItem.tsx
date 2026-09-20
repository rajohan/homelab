import type { NotificationRecord } from "@homelab/contracts/notifications";
import { Badge, IconButton, buttonStyles, formatDateTime } from "@homelab/ui";
import { CheckCheck, Mail, Trash2 } from "lucide-react";

const tones = {
    info: "neutral",
    success: "positive",
    warning: "warning",
    error: "danger",
} as const;
const destinations = {
    alerts: "/alerts",
    jobs: "/jobs",
    applications: "/applications",
    infrastructure: "/infrastructure",
} as const;

/**
 * Present one plain-text notification with personal acknowledgement controls.
 * @returns A compact, responsive notification card with safe internal navigation.
 */
export function NotificationItem({
    notification,
    pending,
    onAction,
}: {
    readonly notification: NotificationRecord;
    readonly pending: boolean;
    readonly onAction: (id: string, action: "read" | "unread" | "dismiss") => void;
}) {
    const unread = notification.readAt === null;
    return (
        <article
            className={
                unread
                    ? "rounded-lg border border-accent-500/35 bg-accent-950/25 p-3"
                    : "rounded-lg border border-primary-700 bg-primary-900 p-3"
            }
            aria-label={notification.title}
        >
            <div className="flex items-start justify-between gap-3">
                <h3 className="min-w-0 text-sm font-semibold wrap-anywhere">
                    {notification.title}
                    {unread && <span className="sr-only"> — Unread</span>}
                </h3>
                <Badge
                    tone={tones[notification.severity]}
                    className="shrink-0 capitalize"
                >
                    {notification.severity}
                </Badge>
            </div>
            <p className="mt-1 text-sm leading-6 wrap-anywhere text-primary-300">
                {notification.message}
            </p>
            <p className="mt-2 text-xs wrap-anywhere text-primary-400">
                {formatDateTime(notification.createdAt)} ·{" "}
                {notification.source.startsWith("automation:")
                    ? "Automation"
                    : notification.source}
            </p>
            <div className="mt-2 flex items-center justify-between gap-2">
                <div>
                    {notification.destination && (
                        <a
                            href={destinations[notification.destination]}
                            className={buttonStyles({ variant: "secondary", size: "sm" })}
                        >
                            Open {notification.destination}
                        </a>
                    )}
                </div>
                <div className="flex gap-1">
                    <IconButton
                        icon={unread ? CheckCheck : Mail}
                        label={`${unread ? "Mark read" : "Mark unread"}: ${notification.title}`}
                        disabled={pending}
                        onClick={() =>
                            onAction(notification.id, unread ? "read" : "unread")
                        }
                    />
                    <IconButton
                        icon={Trash2}
                        label={`Delete notification: ${notification.title}`}
                        disabled={pending}
                        onClick={() => onAction(notification.id, "dismiss")}
                        className="text-red-400 hover:text-red-300"
                    />
                </div>
            </div>
        </article>
    );
}
