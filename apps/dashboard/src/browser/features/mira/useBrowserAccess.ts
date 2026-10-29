import type { MiraRun } from "@homelab/contracts/mira";
import type { MiraBrowserAccessSummary } from "@homelab/contracts/miraBrowser";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import { api } from "../../api/client";

/**
 * Observe only the selected run's owned requests; polling never requests or restores access.
 * @param run - Current run, absent before the operator sends a message.
 * @returns The newest request and freshness/error metadata for conservative presentation.
 */
export function useBrowserAccess(run: MiraRun | null) {
    const runId = run?.id;
    const running = run?.state === "running" && !run.cancelRequested;
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, []);
    const query = useQuery({
        queryKey: ["operations", "mira", "browser-access", runId],
        queryFn: ({ signal }) =>
            runId
                ? api.mira.browser.list.query({ runId }, { signal })
                : Promise.resolve([]),
        ...(runId ? {} : { enabled: false }),
        refetchInterval: (current) => {
            if (running) return 1000;
            const latest = current.state.data?.[0];
            return latest && !["closed"].includes(latest.state) ? 5000 : false;
        },
        retry: false,
    });
    return {
        ...query,
        now,
        fresh:
            !query.error &&
            !query.isPending &&
            now - query.dataUpdatedAt < (running ? 5000 : 10_000),
    };
}

/**
 * Describe observed access without treating a cached badge as an execution permit.
 * @param access - Latest request, if one exists for this exact run.
 * @param run - Current conversation run state.
 * @param fresh - Whether the latest status read is recent and successful.
 * @returns A short user-visible status; actual commands recheck server and local authority.
 */
export function browserAccessLabel(
    access: MiraBrowserAccessSummary | undefined,
    run: MiraRun | null,
    fresh: boolean
): string {
    if (access?.state === "closed") return "Stopped";
    if (access?.state === "stopping") return "Stopping";
    if (!fresh) return "Status unavailable";
    if (!access) return "Not allowed";
    if (access.state === "unavailable" || run?.state !== "running" || run.cancelRequested)
        return "Unavailable";
    if (access.state === "pending") return "Ready to start";
    return access.mode === "view" ? "View only" : "Control";
}
