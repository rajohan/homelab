import {
    ActionGroup,
    Badge,
    DetailFacts,
    DetailSection,
    ErrorNotice,
    EventTimeline,
    formatDateTime,
    InfiniteScrollTrigger,
    LoadingState,
    Modal,
} from "@homelab/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { History, Play, Wrench } from "lucide-react";
import type { ReactNode } from "react";

import { api } from "../../api/client";
import { MiraRunFollowup } from "./MiraRunFollowup";
import { miraStatusTone } from "./statusTone";
import { toolLabel } from "./toolLabel";

/**
 * Inspect durable tool outcomes for the selected run, including old uncertain effects.
 * @returns A bounded historical dialog with paginated receipts and honest loading/error states.
 */
export function MiraRunDetails({
    id,
    onClose,
    footer,
    actions,
}: {
    readonly id: string;
    readonly footer?: ReactNode;
    readonly actions?: ReactNode;
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
        <Modal
            title={run?.title ?? "Run details"}
            icon={History}
            size="wide"
            onClose={onClose}
            titleAccessory={
                run && (
                    <Badge tone={miraStatusTone(run.state)}>
                        {run.state.replaceAll("_", " ")}
                    </Badge>
                )
            }
        >
            <div className="space-y-4">
                {query.isPending && <LoadingState label="Loading run details…" />}
                {query.error && <ErrorNotice error={query.error} />}
                {run && (
                    <>
                        <DetailSection icon={Play} title="Execution">
                            <DetailFacts
                                items={[
                                    {
                                        label: "Queued",
                                        value: formatDateTime(run.createdAt),
                                    },
                                    {
                                        label: "Started",
                                        value: run.startedAt
                                            ? formatDateTime(run.startedAt)
                                            : "Not started",
                                    },
                                    {
                                        label: "Finished",
                                        value: run.finishedAt
                                            ? formatDateTime(run.finishedAt)
                                            : "Not finished",
                                    },
                                ]}
                            />
                            {run.message && (
                                <p className="text-sm wrap-anywhere text-primary-300">
                                    {run.message}
                                </p>
                            )}
                        </DetailSection>
                        <DetailSection icon={Wrench} title="Tool outcomes">
                            {rows.length > 0 ? (
                                <EventTimeline
                                    presentation="feed"
                                    events={rows.map((tool) => {
                                        const tone = miraStatusTone(tool.state);
                                        return {
                                            id: tool.id,
                                            time: new Date(tool.createdAt).toISOString(),
                                            title: toolLabel(tool.tool),
                                            tone: tone === "info" ? "neutral" : tone,
                                            label:
                                                tool.state === "unknown"
                                                    ? "Needs review"
                                                    : tool.state.replaceAll("_", " "),
                                            detail: tool.message,
                                        };
                                    })}
                                />
                            ) : (
                                <p className="text-sm text-primary-400">
                                    No tool calls recorded for this run.
                                </p>
                            )}
                            <InfiniteScrollTrigger
                                itemCount={rows.length}
                                hasMore={query.hasNextPage}
                                loading={query.isFetching}
                                error={query.isError ? query.error : undefined}
                                loadingLabel="Loading older tool outcomes…"
                                onLoadMore={() =>
                                    void (query.isRefetchError
                                        ? query.refetch()
                                        : query.fetchNextPage())
                                }
                            />
                        </DetailSection>
                    </>
                )}
                {run && (
                    <MiraRunFollowup
                        key={run.id}
                        run={run}
                        eligible={
                            !query.isError &&
                            !query.hasNextPage &&
                            !["queued", "running"].includes(run.state) &&
                            (["failed", "interrupted", "needs_attention"].includes(
                                run.state
                            ) ||
                                rows.some((row) => row.state === "unknown"))
                        }
                    />
                )}
                {run && !query.isError && !query.hasNextPage && footer}
                <ActionGroup stretch={false}>
                    {run && !query.isError && !query.hasNextPage && actions}
                </ActionGroup>
            </div>
        </Modal>
    );
}
