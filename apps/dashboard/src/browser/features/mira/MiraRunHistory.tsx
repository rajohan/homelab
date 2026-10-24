import {
    Badge,
    Button,
    buttonStyles,
    Card,
    ErrorNotice,
    formatDateTime,
    LoadingState,
    SectionHeader,
} from "@homelab/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { History } from "lucide-react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";

/**
 * Reuse agent execution history in Jobs and Mira without copying run records.
 * @returns Bounded durable run outcomes, stop controls and conversation links.
 */
export function MiraRunHistory() {
    const query = useInfiniteQuery({
        queryKey: ["operations", "mira", "runs"],
        initialPageParam: undefined as string | undefined,
        queryFn: ({ pageParam }) =>
            api.mira.runs.list.query({
                search: "",
                archived: false,
                ...(pageParam ? { before: pageParam } : {}),
            }),
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        refetchInterval: 5000,
    });
    const stop = useOperation((id: string) => api.mira.runs.cancel.mutate({ id }));
    const rows = query.data?.pages.flatMap((page) => page.rows) ?? [];
    return (
        <Card className="space-y-4">
            <SectionHeader
                title="Mira runs"
                icon={History}
                description="Agent work and outcomes across chat and automations."
            />
            {query.isPending && <LoadingState label="Loading Mira runs…" />}
            {(query.error || stop.error) && (
                <ErrorNotice error={query.error ?? stop.error} />
            )}
            <div className="max-h-96 space-y-3 overflow-y-auto">
                {rows.map((run) => (
                    <article
                        key={run.id}
                        className="flex flex-col gap-3 rounded-lg border border-primary-700 bg-primary-900/40 p-3 sm:flex-row sm:items-center sm:justify-between"
                    >
                        <div className="min-w-0 space-y-2">
                            <div className="flex flex-wrap items-center gap-2">
                                <Badge
                                    tone={
                                        run.state === "needs_attention" ||
                                        run.state === "failed"
                                            ? "warning"
                                            : "neutral"
                                    }
                                >
                                    {run.state.replaceAll("_", " ")}
                                </Badge>
                                <Link
                                    className={buttonStyles({
                                        variant: "secondary",
                                        className: "w-full sm:w-auto",
                                    })}
                                    to="/mira/$conversationId"
                                    params={{ conversationId: run.conversationId }}
                                >
                                    {run.automationId
                                        ? "Automation conversation"
                                        : "Conversation"}
                                </Link>
                            </div>
                            <p className="text-xs text-primary-400">
                                {formatDateTime(run.createdAt)}
                            </p>
                            {run.message && (
                                <p className="text-sm text-primary-300">{run.message}</p>
                            )}
                        </div>
                        {["queued", "running"].includes(run.state) && (
                            <Button
                                variant="secondary"
                                busy={stop.isPending && stop.variables === run.id}
                                disabled={run.cancelRequested}
                                onClick={() => stop.mutate(run.id)}
                            >
                                {run.cancelRequested ? "Stopping" : "Stop"}
                            </Button>
                        )}
                    </article>
                ))}
            </div>
            {!query.isPending && rows.length === 0 && (
                <p className="text-sm text-primary-400">No Mira runs yet.</p>
            )}
            {query.hasNextPage && (
                <Button
                    fullWidth
                    variant="secondary"
                    busy={query.isFetchingNextPage}
                    onClick={() => void query.fetchNextPage()}
                >
                    Load more runs
                </Button>
            )}
        </Card>
    );
}
