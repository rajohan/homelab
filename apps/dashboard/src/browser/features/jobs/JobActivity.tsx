import {
    ErrorNotice,
    LoadingState,
    Popover,
    VirtualList,
    queryRefresh,
    type PopoverControl,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { Cog } from "lucide-react";
import { useState, type Ref } from "react";

import { api } from "../../api/client";
import { JobActivityItem } from "./JobActivityItem";
import { RunDetailDialog } from "./RunDetailDialog";

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
    const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
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
    const runs = [
        ...new Map((query.data?.runs ?? []).map((run) => [run.id, run])).values(),
    ].filter((run) => !dismissed.has(run.id));
    const running = runs.filter((run) => run.state === "running").length;
    const queued = runs.filter((run) => run.state === "queued").length;
    const active = running + queued;
    const label = query.isPending
        ? "Worker activity, loading"
        : `Worker activity, ${running} running, ${queued} queued`;
    return (
        <>
            <Popover
                controlRef={controlRef}
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
                    <section aria-label="Worker activity" className="space-y-4">
                        <div>
                            <h2 className="text-lg font-semibold">Worker activity</h2>
                            <p className="mt-1 text-sm text-primary-400">
                                Your active and recently completed jobs.
                            </p>
                        </div>
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
                            <p className="rounded-lg border border-primary-700 bg-primary-950 p-4 text-sm text-primary-400">
                                No active or recently completed jobs.
                            </p>
                        )}
                        {runs.length > 0 && (
                            <VirtualList
                                label="Your job activity"
                                rows={runs}
                                getKey={(run) => run.id}
                                className="max-h-[min(26rem,60dvh)]"
                                itemClassName="pb-2 last-of-type:pb-0"
                                scrollbarGap
                                renderItem={(run) => (
                                    <JobActivityItem
                                        run={run}
                                        unavailable={query.isError}
                                        onSelect={() => {
                                            close();
                                            setSelected(run.id);
                                        }}
                                        onDismiss={() =>
                                            setDismissed(
                                                (current) => new Set([...current, run.id])
                                            )
                                        }
                                    />
                                )}
                            />
                        )}
                    </section>
                )}
            </Popover>
            {selected && (
                <RunDetailDialog id={selected} onClose={() => setSelected(undefined)} />
            )}
        </>
    );
}
