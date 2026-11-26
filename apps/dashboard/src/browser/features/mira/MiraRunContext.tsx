import type { MiraRunSummary } from "@homelab/contracts/mira";
import { formatDateTime } from "@homelab/ui";

function runSource(run: MiraRunSummary) {
    if (run.automationName) return run.automationName;
    if (run.automationId) return "Automation";
    return run.taskId ? "Task" : "Chat";
}

/** Show the conversation source and optional message for a run in the jobs table.
 * @returns The context shown below the title or status for the active layout.
 */
export function MiraRunContext({
    run,
    withQueuedTime = false,
}: {
    readonly run: MiraRunSummary;
    readonly withQueuedTime?: boolean;
}) {
    return (
        <div className={withQueuedTime ? "@3xl:hidden" : "hidden @3xl:block"}>
            <p className="text-xs leading-4 text-primary-400">
                {runSource(run)}
                {withQueuedTime && (
                    <>
                        <span aria-hidden="true"> · </span>
                        <time
                            dateTime={run.createdAt}
                            title="Queued"
                            className="inline-block"
                        >
                            <span className="sr-only">Queued </span>
                            {formatDateTime(run.createdAt)}
                        </time>
                    </>
                )}
            </p>
            {run.message && (
                <p className="mt-1 text-xs text-primary-300">{run.message}</p>
            )}
        </div>
    );
}
