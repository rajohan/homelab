import type { NotificationRecord } from "@homelab/contracts/notifications";
import { Badge, formatDateTime, IconButton } from "@homelab/ui";
import { Link } from "@tanstack/react-router";
import { CheckCheck, Mail, Trash2 } from "lucide-react";

import { describeNotification } from "./describeNotification";
import { notificationTarget } from "./notificationTarget";

const tones = {
    info: "neutral",
    success: "positive",
    warning: "warning",
    error: "danger",
} as const;

/**
 * Present one plain-text notification with personal acknowledgement controls.
 * @returns A compact, responsive notification card with safe internal navigation.
 */
export function NotificationItem({
    notification,
    pending,
    onAction,
    onNavigate,
}: {
    readonly notification: NotificationRecord;
    readonly pending: boolean;
    readonly onAction: (id: string, action: "read" | "unread" | "dismiss") => void;
    readonly onNavigate: () => void;
}) {
    const unread = notification.readAt === null;
    const target = notificationTarget(notification);
    let destination: string | null = notification.destination;
    if (notification.restartBatchId) destination = "restart details";
    else if (notification.jobRunId) destination = "job details";
    const display = describeNotification(notification);
    const source = notification.source.startsWith("automation:")
        ? "Automation"
        : notification.source;
    const titleClass = unread
        ? "text-primary-50 font-semibold"
        : "text-primary-300 font-medium";
    return (
        <article
            aria-label={notification.title}
            className="border-t border-primary-700 py-3 ps-1 pe-scrollbar-inset"
        >
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-primary-400">
                <Badge tone={tones[notification.severity]} className="capitalize">
                    {display.label === "Resolved" ? display.label : notification.severity}
                </Badge>
                <span className="sr-only">{notification.severity}</span>
                {unread && <span className="font-medium text-accent-300">Unread</span>}
                <time dateTime={notification.createdAt} className="ml-auto tabular-nums">
                    {formatDateTime(notification.createdAt)}
                </time>
            </div>
            <div className="mt-1.5 flex items-start justify-between gap-2">
                <div className="min-w-0 flex-1">
                    <h3 className={`text-sm leading-snug wrap-anywhere ${titleClass}`}>
                        {target ? (
                            <Link
                                {...target}
                                onClick={onNavigate}
                                title={notification.title}
                                aria-label={`${destination === "alerts" ? "Inspect incident" : "Open " + destination}: ${display.title}`}
                                className="inline-block rounded py-1 underline-offset-4 hover:text-accent-300 hover:underline focus-visible:outline-2 focus-visible:outline-accent-300"
                            >
                                {display.title}
                            </Link>
                        ) : (
                            display.title
                        )}
                    </h3>
                    <p className="text-xs leading-relaxed wrap-anywhere text-primary-300">
                        {display.detail}
                        {display.detail && <span aria-hidden="true"> · </span>}
                        <span className="text-primary-400">{source}</span>
                    </p>
                </div>
                <div className="flex shrink-0">
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
                        className="text-primary-400 hover:text-red-300"
                    />
                </div>
            </div>
        </article>
    );
}
