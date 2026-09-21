import type { JobSummary } from "@homelab/contracts/operations";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

type ObservedRuns = readonly Pick<JobSummary, "id" | "action" | "finishedAt">[];

function synchronizeUpdateCache(
    client: QueryClient,
    runs: ObservedRuns | undefined,
    seen: Set<string>
): Set<string> {
    if (!runs) return seen;
    const completed = runs.filter(
        (run) => run.action.startsWith("updates.") && run.finishedAt !== null
    );
    if (completed.some((run) => !seen.has(run.id)))
        void client.invalidateQueries({ queryKey: ["operations", "updates"] });
    return new Set(completed.map((run) => run.id));
}

/**
 * Refresh observations when an update completes, independently of the open route.
 * @param runs - The operator's bounded activity response; each completion refreshes once.
 */
export function useJobCompletionRefresh(runs: ObservedRuns | undefined): void {
    const client = useQueryClient();
    const seen = useRef(new Set<string>());
    useEffect(() => {
        seen.current = synchronizeUpdateCache(client, runs, seen.current);
    }, [client, runs]);
}
