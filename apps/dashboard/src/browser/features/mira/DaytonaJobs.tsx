import type { MiraDaytonaJob } from "@homelab/contracts/miraDaytona";
import {
    Badge,
    Button,
    Card,
    InfiniteScrollTrigger,
    LoadingState,
    Modal,
    SectionHeader,
} from "@homelab/ui";
import { useInfiniteQuery } from "@tanstack/react-query";
import { Cloud, Plus, Server, Terminal } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { DaytonaDetails } from "./DaytonaDetails";
import { DaytonaEditor } from "./DaytonaEditor";
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
    const [editing, setEditing] = useState<MiraDaytonaJob | "new">();
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
                actions={
                    <Button onClick={() => setEditing("new")}>
                        <Plus size={16} />
                        New job
                    </Button>
                }
            />
            {query.isPending && <LoadingState label="Loading code jobs…" />}
            {!query.isPending && !query.error && rows.length === 0 && (
                <p className="text-sm text-primary-400">
                    No code jobs yet. Save a draft, then review the command and selected
                    files before starting.
                </p>
            )}
            <div className="max-h-128 space-y-3 overflow-y-auto">
                {rows.map((job) => (
                    <Card key={job.id} className="space-y-3 bg-primary-900/40">
                        <SectionHeader
                            title={job.content.title}
                            icon={job.executionTarget === "main" ? Server : Cloud}
                            badge={
                                <Badge tone={daytonaTones[job.state]}>
                                    {job.state.replaceAll("_", " ")}
                                </Badge>
                            }
                            description={`${job.executionTarget === "main" ? "Main" : "Daytona"} · ${daytonaCleanupDescriptions[job.cleanup]}`}
                            actions={
                                <>
                                    <Button
                                        variant="secondary"
                                        onClick={() => setSelected(job)}
                                    >
                                        {job.state === "draft" ? "Review" : "View job"}
                                    </Button>
                                    {job.state === "draft" && (
                                        <Button
                                            variant="secondary"
                                            onClick={() => setEditing(job)}
                                        >
                                            Edit
                                        </Button>
                                    )}
                                </>
                            }
                        />
                        {job.message && (
                            <p className="text-sm text-primary-300">{job.message}</p>
                        )}
                    </Card>
                ))}
            </div>
            <InfiniteScrollTrigger
                itemCount={query.data?.pages.length ?? 0}
                hasMore={query.hasNextPage}
                loading={query.isFetchingNextPage}
                refreshing={query.isRefetching}
                error={query.isError ? query.error : undefined}
                onLoadMore={() =>
                    void (query.isRefetchError ? query.refetch() : query.fetchNextPage())
                }
            />
        </div>
    );
    if (editing)
        return (
            <DaytonaEditor
                job={editing === "new" ? undefined : editing}
                conversationId={conversationId}
                onClose={() => setEditing(undefined)}
            />
        );
    if (selected)
        return <DaytonaDetails job={selected} onClose={() => setSelected(undefined)} />;
    return onClose ? (
        <Modal title="Code jobs" onClose={onClose} size="wide">
            {content}
        </Modal>
    ) : (
        <Card>{content}</Card>
    );
}
