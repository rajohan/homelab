import type { MiraRunSummary } from "@homelab/contracts/mira";

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
    className,
}: {
    readonly run: MiraRunSummary;
    readonly className: string;
}) {
    return (
        <div className={className}>
            <p className="text-xs text-primary-400">{runSource(run)}</p>
            {run.message && (
                <p className="mt-1 text-xs text-primary-300">{run.message}</p>
            )}
        </div>
    );
}
