import type { JobSummary } from "@homelab/contracts/operations";
import { Badge, IconButton } from "@homelab/ui";
import { CheckCircle2, Clock3, CircleAlert, LoaderCircle, X } from "lucide-react";

import { JobStatus } from "./JobStatus";

const descriptions = {
    queued: "Waiting for a worker.",
    running: "Execution is in progress.",
    succeeded: "Completed successfully.",
    failed: "Execution failed. Open the run for details.",
    timed_out: "Execution exceeded its time limit.",
    cancelled: "Execution was cancelled.",
} as const;

const presentation = {
    queued: { icon: Clock3, color: "text-accent-400" },
    running: { icon: LoaderCircle, color: "text-accent-400 motion-safe:animate-spin" },
    succeeded: { icon: CheckCircle2, color: "text-emerald-400" },
    failed: { icon: CircleAlert, color: "text-red-400" },
    timed_out: { icon: CircleAlert, color: "text-red-400" },
    cancelled: { icon: Clock3, color: "text-primary-400" },
} as const;

/**
 * Present one worker-owned status without triggering or retrying the underlying operation.
 * @returns A keyboard-accessible run link with progress and an independent dismiss control.
 */
export function JobActivityItem({
    run,
    unavailable,
    onSelect,
    onDismiss,
}: {
    readonly run: JobSummary;
    readonly unavailable: boolean;
    readonly onSelect: () => void;
    readonly onDismiss: () => void;
}) {
    const active = run.state === "queued" || run.state === "running";
    const { icon: Icon, color } = unavailable
        ? { icon: CircleAlert, color: "text-amber-400" }
        : presentation[run.state];
    return (
        <div className="relative flex items-center gap-1 rounded-lg border border-primary-700 bg-primary-900 pr-2 transition-colors hover:bg-primary-700/50">
            <button
                type="button"
                aria-label={`View ${run.label}`}
                onClick={onSelect}
                className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-lg p-3 text-left after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-accent-500"
            >
                <Icon size={18} aria-hidden="true" className={`shrink-0 ${color}`} />
                <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="truncate text-sm font-semibold">
                            {run.label}
                        </span>
                        {unavailable ? (
                            <Badge tone="warning">Status unavailable</Badge>
                        ) : (
                            <JobStatus state={run.state} />
                        )}
                    </span>
                    <span
                        aria-live="polite"
                        aria-atomic="true"
                        className="mt-1 block truncate text-xs text-primary-400"
                    >
                        {run.cancelRequested && active
                            ? "Cancellation requested."
                            : (run.message ?? descriptions[run.state])}
                    </span>
                </span>
            </button>
            {!active && (
                <IconButton
                    icon={X}
                    label={`Dismiss ${run.label}`}
                    onClick={onDismiss}
                    className="relative z-10"
                />
            )}
        </div>
    );
}
