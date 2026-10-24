import {
    ActionGroup,
    Badge,
    Button,
    DataTable,
    ErrorNotice,
    formatDateTime,
    LoadingState,
    Modal,
    SectionHeader,
} from "@homelab/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import type { ReactNode } from "react";

import { api } from "../../api/client";

function outcomeTone(state: string) {
    if (["needs_attention", "unknown"].includes(state)) return "warning";
    if (state === "failed") return "danger";
    return "neutral";
}

/**
 * Inspect durable tool outcomes for the selected run, including old uncertain effects.
 * @returns A bounded historical dialog with paginated receipts and honest loading/error states.
 */
export function MiraRunDetails({
    id,
    onClose,
    footer,
}: {
    readonly id: string;
    readonly footer?: ReactNode;
    readonly onClose: () => void;
}) {
    const query = useInfiniteQuery({
        queryKey: ["operations", "mira", "run", id],
        initialPageParam: undefined as string | undefined,
        queryFn: ({ pageParam }) =>
            api.mira.runs.read.query({ id, ...(pageParam ? { before: pageParam } : {}) }),
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        refetchInterval: 5000,
    });
    const run = query.data?.pages[0]?.run;
    const rows = query.data?.pages.flatMap((page) => page.rows) ?? [];
    return (
        <Modal title="Run details" size="wide" onClose={onClose}>
            <div className="space-y-4">
                {query.isPending && <LoadingState label="Loading run details…" />}
                {query.error && <ErrorNotice error={query.error} />}
                {run && (
                    <>
                        <SectionHeader
                            title={run.title}
                            icon={History}
                            description={formatDateTime(run.createdAt)}
                            badge={
                                <Badge tone={outcomeTone(run.state)}>
                                    {run.state.replaceAll("_", " ")}
                                </Badge>
                            }
                        />
                        {run.message && (
                            <p className="text-sm wrap-anywhere text-primary-300">
                                {run.message}
                            </p>
                        )}
                        {rows.length > 0 ? (
                            <DataTable
                                label="Tool outcomes"
                                compact
                                rows={rows}
                                getKey={(tool) => tool.id}
                                columns={[
                                    {
                                        id: "tool",
                                        label: "Tool",
                                        mobile: "title",
                                        render: (tool) => (
                                            <div className="space-y-1">
                                                <p className="font-medium text-primary-100">
                                                    {tool.tool
                                                        .replace(/^mira_/, "")
                                                        .replaceAll("_", " ")}
                                                </p>
                                                {tool.message && (
                                                    <p className="text-xs wrap-anywhere text-primary-300">
                                                        {tool.message}
                                                    </p>
                                                )}
                                            </div>
                                        ),
                                    },
                                    {
                                        id: "state",
                                        label: "Outcome",
                                        width: "w-40",
                                        render: (tool) => (
                                            <Badge tone={outcomeTone(tool.state)}>
                                                {tool.state === "unknown"
                                                    ? "Needs review"
                                                    : tool.state.replaceAll("_", " ")}
                                            </Badge>
                                        ),
                                    },
                                    {
                                        id: "time",
                                        label: "Started",
                                        width: "w-48",
                                        render: (tool) => formatDateTime(tool.createdAt),
                                    },
                                ]}
                                continuation={{
                                    hasMore: query.hasNextPage,
                                    loading: query.isFetching,
                                    error: query.isError ? query.error : undefined,
                                    loadingLabel: "Loading older tool outcomes…",
                                    onLoadMore: () =>
                                        void (query.isRefetchError
                                            ? query.refetch()
                                            : query.fetchNextPage()),
                                }}
                            />
                        ) : (
                            <p className="text-sm text-primary-400">
                                No tool calls recorded for this run.
                            </p>
                        )}
                    </>
                )}
                {run &&
                    !query.isError &&
                    !query.isFetching &&
                    !query.hasNextPage &&
                    footer}
                <ActionGroup>
                    <Button variant="secondary" onClick={onClose}>
                        Close
                    </Button>
                </ActionGroup>
            </div>
        </Modal>
    );
}
