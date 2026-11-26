import type { MiraDaytonaJob } from "@homelab/contracts/miraDaytona";
import {
    Badge,
    Card,
    HistoryEntry,
    LoadingState,
    Modal,
    ScrollList,
    SectionHeader,
} from "@homelab/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Cloud, Eye, Server, Terminal } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { DaytonaDetails } from "./DaytonaDetails";
import { daytonaCleanupDescriptions, daytonaTones } from "./daytonaPresentation";

/**
 * Show durable code work in Jobs or an owned conversation.
 * @returns Shared bounded history and explicit draft/review actions.
 */
export function DaytonaJobs({
    onClose,
    conversationId,
}: {
    readonly onClose?: () => void;
    readonly conversationId?: string | undefined;
}) {
    const [selected, setSelected] = useState<MiraDaytonaJob>();
    const query = useInfiniteQuery({
        queryKey: ["operations", "mira", "daytona", conversationId],
        initialPageParam: undefined as string | undefined,
        queryFn: ({ pageParam }) =>
            api.mira.daytona.list.query({
                ...(conversationId ? { conversationId } : {}),
                ...(pageParam ? { before: pageParam } : {}),
            }),
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        refetchInterval: 5000,
    });
    const rows = query.data?.pages.flatMap((page) => page.rows) ?? [];
    const content = (
        <div className="space-y-4">
            <SectionHeader
                title={onClose ? "Commands and results" : "Code jobs"}
                icon={Terminal}
                description="Main and Daytona commands, logs and results."
            />
            {query.isPending && <LoadingState label="Loading code jobs…" />}
            {!query.isPending && !query.error && rows.length === 0 && (
                <p className="text-sm text-primary-400">
                    No code jobs yet. Ask Mira to prepare a command in Chat.
                </p>
            )}
            <ScrollList
                label="Code job history"
                rows={rows}
                getKey={(job) => job.id}
                framed
                className="max-h-128"
                renderItem={(job) => (
                    <HistoryEntry
                        title={job.content.title}
                        icon={job.executionTarget === "main" ? Server : Cloud}
                        badge={
                            <Badge tone={daytonaTones[job.state]}>
                                {job.state.replaceAll("_", " ")}
                            </Badge>
                        }
                        showSingleActionInline
                        actions={[
                            {
                                id: "details",
                                label: job.state === "draft" ? "Review" : "View job",
                                icon: Eye,
                                onSelect: () => setSelected(job),
                            },
                        ]}
                    >
                        <p className="text-primary-400">
                            {job.executionTarget === "main" ? "Main" : "Daytona"} ·{" "}
                            {daytonaCleanupDescriptions[job.cleanup]}
                        </p>
                        {job.message && <p className="text-primary-300">{job.message}</p>}
                    </HistoryEntry>
                )}
                continuation={{
                    hasMore: query.hasNextPage,
                    loading: query.isFetchingNextPage,
                    refreshing: query.isRefetching,
                    error: query.isError ? query.error : undefined,
                    onLoadMore: () =>
                        void (query.isRefetchError
                            ? query.refetch()
                            : query.fetchNextPage()),
                }}
            />
            {selected && (
                <DaytonaDetails job={selected} onClose={() => setSelected(undefined)} />
            )}
        </div>
    );
    return onClose ? (
        <Modal title="Code jobs" onClose={onClose} size="wide">
            {content}
        </Modal>
    ) : (
        <Card>{content}</Card>
    );
}
