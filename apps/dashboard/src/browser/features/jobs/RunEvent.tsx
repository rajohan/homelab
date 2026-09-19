import { formatDateTime } from "@homelab/ui";

import { formatJobActor } from "./formatJobActor";

const labels: Readonly<Record<string, string>> = {
    "jobs.enqueue": "Queued",
    "jobs.cancel": "Cancellation requested",
    "jobs.queued": "Queued",
    "jobs.started": "Started",
    "jobs.progress": "Progress update",
    "jobs.succeeded": "Completed successfully",
    "jobs.failed": "Failed",
    "jobs.cancelled": "Cancelled",
    "jobs.cancel_requested": "Cancellation requested",
    "jobs.timed_out": "Timed out",
    "jobs.retry": "Retry scheduled",
};

/**
 * Present a shared worker lifecycle event or a code-owned progress message.
 * @returns A readable, timestamped event without rendering job payloads or provider output.
 */
export function RunEvent({
    event,
}: {
    readonly event: {
        action: string;
        actor: string;
        message: string | null;
        createdAt: string;
    };
}) {
    return (
        <div>
            <p className="wrap-anywhere">
                {event.message ?? labels[event.action] ?? event.action}
            </p>
            <p className="text-xs wrap-anywhere text-primary-400">
                {formatDateTime(event.createdAt)} · {formatJobActor(event.actor)}
            </p>
        </div>
    );
}
