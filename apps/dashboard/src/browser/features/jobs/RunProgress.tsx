import { formatDateTime } from "@homelab/ui";
import { useEffect, useState } from "react";

/**
 * Explain elapsed time and liveness without inventing a percentage or equating silence with failure.
 * @param props - Fenced run status returned by the regularly refreshed job inspector.
 * @returns Timing and the last reported phase, distinct from worker responsiveness.
 */
export function RunProgress({
    run,
}: {
    readonly run: {
        readonly state: string;
        readonly startedAt: string | null;
        readonly finishedAt: string | null;
        readonly message: string | null;
        readonly lastProgressAt: string | null;
        readonly responding: boolean;
    };
}) {
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        if (run.state !== "running") return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [run.state]);
    const seconds = run.startedAt
        ? Math.max(
              0,
              Math.floor(
                  ((run.finishedAt ? Date.parse(run.finishedAt) : now) -
                      Date.parse(run.startedAt)) /
                      1000
              )
          )
        : 0;
    return (
        <div
            className="space-y-2 rounded-lg border border-primary-700 bg-primary-950/40 p-3 text-sm"
            aria-label="Run progress"
        >
            <p>
                Elapsed: {Math.floor(seconds / 60)}m {seconds % 60}s
            </p>
            {["queued", "running"].includes(run.state) && (
                <p>
                    {run.message ??
                        (run.state === "queued"
                            ? "Waiting for an available slot and the required resources."
                            : "No progress message has been reported.")}
                </p>
            )}
            {run.lastProgressAt && (
                <p className="text-primary-400">
                    Last progress: {formatDateTime(run.lastProgressAt)}
                </p>
            )}
            {run.state === "running" && (
                <p className="text-primary-400">
                    {run.responding
                        ? "Worker responding. Some steps take several minutes without a new progress message."
                        : "Worker response is overdue. The operation's outcome has not yet been confirmed."}
                </p>
            )}
        </div>
    );
}
