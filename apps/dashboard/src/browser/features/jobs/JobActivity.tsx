import {
    ActivityPanel,
    EmptyState,
    ErrorNotice,
    LoadingState,
    Popover,
    type PopoverControl,
    queryRefresh,
    SummaryStrip,
    VirtualList,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Cog } from "lucide-react";
import { type Ref, useState } from "react";

import { api } from "../../api/client";
import { JobActivityItem } from "./JobActivityItem";
import { RunDetailDialog } from "./RunDetailDialog";
import { useJobCompletionRefresh } from "./useJobCompletionRefresh";

const dismissalKey = "homelab:job-activity:dismissed";

function readDismissed(): ReadonlySet<string> {
    try {
        const stored: unknown = JSON.parse(
            globalThis.localStorage.getItem(dismissalKey) ?? "[]"
        );
        return new Set(
            Array.isArray(stored)
                ? stored
                      .slice(-1000)
                      .filter(
                          (id): id is string => typeof id === "string" && id.length === 36
                      )
                : []
        );
    } catch {
        return new Set();
    }
}

/**
 * Keep the current operator's jobs accessible across routes and browser refreshes.
 * @returns An animated header trigger and an on-demand activity panel with optional details.
 */
export function JobActivity({
    controlRef,
}: {
    readonly controlRef?: Ref<PopoverControl>;
}) {
    const [selected, setSelected] = useState<string>();
    const [dismissed, setDismissed] = useState(readDismissed);
    function dismiss(id: string) {
        const next = new Set([...readDismissed(), ...dismissed, id].slice(-1000));
        setDismissed(next);
        try {
            // Store only opaque completed-run IDs, never messages or job payloads.
            globalThis.localStorage.setItem(dismissalKey, JSON.stringify([...next]));
        } catch {
            // Restricted storage must not prevent dismissal in the current page.
        }
    }
    const query = useQuery({
        queryKey: ["operations", "jobs", "activity"],
        queryFn: ({ signal }) => api.jobs.activity.query(undefined, { signal }),
        ...queryRefresh("fast"),
        refetchInterval: (current) =>
            queryRefresh(
                current.state.data?.runs.some(
                    (run) => run.state === "queued" || run.state === "running"
                )
                    ? "progress"
                    : "fast"
            ).refetchInterval,
        retry: false,
    });
    useJobCompletionRefresh(query.data?.runs);
    const runs = [
        ...new Map((query.data?.runs ?? []).map((run) => [run.id, run])).values(),
    ].filter(
        (run) =>
            run.state === "queued" || run.state === "running" || !dismissed.has(run.id)
    );
    const running = runs.filter((run) => run.state === "running").length;
    const queued = runs.filter((run) => run.state === "queued").length;
    const active = running + queued;
    const summary = query.isPending ? "Checking queue…" : "Your jobs";
    const label = query.isPending
        ? "Worker activity, loading"
        : `Worker activity, ${running} running, ${queued} queued`;
    return (
        <>
            <Popover
                controlRef={controlRef}
                layout="feed"
                label={query.isError ? "Worker activity, status unavailable" : label}
                trigger={
                    <>
                        <Cog
                            size={20}
                            aria-hidden="true"
                            className={
                                running > 0 && !query.isError
                                    ? "text-accent-400 motion-safe:animate-[spin_3s_linear_infinite]"
                                    : undefined
                            }
                        />
                        {active > 0 && !query.isError && (
                            <span
                                aria-hidden="true"
                                className="absolute top-0 right-0 min-w-4 rounded-full bg-accent-600 px-1 text-center text-xs leading-4 font-semibold text-white"
                            >
                                {active > 99 ? "99+" : active}
                            </span>
                        )}
                        {query.isError && (
                            <span
                                aria-hidden="true"
                                className="absolute top-1 right-1 size-2 rounded-full bg-amber-400"
                            />
                        )}
                    </>
                }
            >
                {({ close }) => (
                    <ActivityPanel
                        title="Worker activity"
                        icon={Cog}
                        onClose={close}
                        summary={query.isError ? "Status unavailable" : summary}
                    >
                        {query.data && !query.isError && (
                            <SummaryStrip
                                label="Your job counts"
                                items={[
                                    { label: "Running", value: running, tone: "info" },
                                    { label: "Queued", value: queued },
                                ]}
                            />
                        )}
                        {query.isPending && (
                            <LoadingState label="Loading job activity…" />
                        )}
                        {query.isError && (
                            <ErrorNotice
                                error={
                                    new Error(
                                        "Job activity is unavailable. Last reported states may be out of date."
                                    )
                                }
                            />
                        )}
                        {!query.isPending && !query.isError && runs.length === 0 && (
                            <EmptyState
                                compact
                                icon={Cog}
                                title="No active jobs"
                                description="Open job history to see earlier runs."
                            />
                        )}
                        <div>
                            {runs.length > 0 && (
                                <VirtualList
                                    label="Your job activity"
                                    rows={runs}
                                    getKey={(run) => run.id}
                                    className="max-h-[min(26rem,60dvh)] rounded-none"
                                    itemClassName="pb-0"
                                    scrollbarGap
                                    renderItem={(run) => (
                                        <JobActivityItem
                                            run={run}
                                            unavailable={query.isError}
                                            onSelect={() => {
                                                close();
                                                setSelected(run.id);
                                            }}
                                            onDismiss={() => dismiss(run.id)}
                                        />
                                    )}
                                />
                            )}
                            <div className="flex flex-wrap gap-x-4 border-t border-primary-700 pt-1">
                                {(
                                    [
                                        { hash: "queue", label: "Open queue" },
                                        { hash: "history", label: "Job history" },
                                    ] as const
                                ).map((item) => (
                                    <Link
                                        key={item.hash}
                                        to="/jobs"
                                        hash={item.hash}
                                        onClick={() => close()}
                                        className="inline-flex min-h-11 items-center gap-1.5 rounded text-sm font-medium text-accent-300 hover:underline"
                                    >
                                        {item.label}
                                        <ArrowRight size={14} aria-hidden="true" />
                                    </Link>
                                ))}
                            </div>
                        </div>
                    </ActivityPanel>
                )}
            </Popover>
            {selected && (
                <RunDetailDialog id={selected} onClose={() => setSelected(undefined)} />
            )}
        </>
    );
}
