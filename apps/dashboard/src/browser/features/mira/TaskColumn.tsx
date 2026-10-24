import { useDroppable } from "@dnd-kit/react";
import type { MiraTask } from "@homelab/contracts/mira";
import { Badge, Button, ErrorNotice, LoadingState, SectionHeader } from "@homelab/ui";
import { useInfiniteQuery } from "@tanstack/react-query";

import { api } from "../../api/client";
import { TaskCard } from "./TaskCard";
import { taskStates } from "./taskPresentation";

/**
 * Paginate one board column independently so a busy state cannot hide other tasks.
 * @returns Filtered tasks using the existing card, badge and loading components.
 */
export function TaskColumn({
    status,
    search,
    assignee,
    onSelect,
    disabled,
}: {
    readonly disabled: boolean;
    readonly status: MiraTask["status"];
    readonly search: string;
    readonly assignee: MiraTask["assignee"] | "all";
    readonly onSelect: (task: MiraTask) => void;
}) {
    const { ref, isDropTarget } = useDroppable({
        id: `task-column:${status}`,
        type: "task-column",
        accept: "task-card",
        disabled,
    });
    const query = useInfiniteQuery({
        queryKey: ["operations", "mira", "tasks", status, search, assignee],
        initialPageParam: undefined as string | undefined,
        queryFn: ({ pageParam, signal }) =>
            api.mira.tasks.list.query(
                {
                    search,
                    archived: false,
                    status,
                    ...(assignee === "all" ? {} : { assignee }),
                    ...(pageParam ? { before: pageParam } : {}),
                },
                { signal }
            ),
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        refetchInterval: 15_000,
    });
    const rows = query.data?.pages.flatMap((page) => page.rows) ?? [];
    return (
        <section
            className="flex min-w-0 flex-col gap-3"
            aria-label={`${taskStates[status].title} tasks`}
        >
            <SectionHeader
                title={taskStates[status].title}
                icon={taskStates[status].icon}
                badge={
                    <Badge>
                        {rows.length}
                        {query.hasNextPage ? "+" : ""}
                    </Badge>
                }
            />
            {query.isPending && <LoadingState label="Loading tasks…" />}
            {query.error && <ErrorNotice error={query.error} />}
            <div
                ref={ref}
                className={`min-h-64 flex-1 space-y-3 rounded-xl border border-dashed p-3 transition-colors md:max-h-[calc(100dvh-19rem)] md:overflow-y-auto md:overscroll-contain ${isDropTarget ? "border-accent-400 bg-accent-900/20" : "border-primary-700/60 bg-primary-800/30"}`}
            >
                {rows.map((task) => (
                    <TaskCard
                        key={task.id}
                        task={task}
                        disabled={disabled}
                        onSelect={onSelect}
                    />
                ))}
                {!query.isPending && rows.length === 0 && (
                    <p className="py-6 text-center text-sm text-primary-400">
                        No matching tasks.
                    </p>
                )}
                {query.hasNextPage && (
                    <Button
                        fullWidth
                        variant="secondary"
                        busy={query.isFetchingNextPage}
                        onClick={() => void query.fetchNextPage()}
                    >
                        Load more
                    </Button>
                )}
            </div>
        </section>
    );
}
