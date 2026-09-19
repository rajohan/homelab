import {
    Card,
    ErrorNotice,
    LoadingState,
    SectionHeader,
    buttonStyles,
    queryRefresh,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ListChecks } from "lucide-react";

import { api } from "../../api/client";
import { MetricStat } from "../infrastructure/MetricStat";

/**
 * Reuse the worker inventory to summarize active work and retained failed executions.
 * @returns Queue counts with links to the canonical job history.
 */
export function QueueSummary() {
    const query = useQuery({
        queryKey: ["operations", "worker"],
        queryFn: ({ signal }) => api.worker.overview.query(undefined, { signal }),
        ...queryRefresh("fast"),
        retry: false,
    });
    const count = (state: string) =>
        query.data?.counts.find((item) => item.state === state)?.count ?? 0;
    return (
        <Card className="space-y-4">
            <SectionHeader
                title="Background work"
                description="Queue activity and retained execution outcomes."
                icon={ListChecks}
            />
            {query.isPending && <LoadingState label="Loading worker status…" />}
            {query.isError && <ErrorNotice error={query.error} />}
            {query.data && (
                <>
                    <dl className="grid grid-cols-3 gap-3">
                        <MetricStat label="Queued" value={count("queued")} />
                        <MetricStat label="Running" value={count("running")} />
                        <MetricStat
                            label="Failed / timed out"
                            value={count("failed") + count("timed_out")}
                        />
                    </dl>
                    <Link
                        to="/jobs"
                        className={buttonStyles({
                            variant: "secondary",
                            className: "w-full",
                        })}
                    >
                        View jobs
                    </Link>
                </>
            )}
        </Card>
    );
}
