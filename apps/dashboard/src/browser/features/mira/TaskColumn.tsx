import { useDroppable } from "@dnd-kit/react";
import type { MiraTask } from "@homelab/contracts/mira";
import { Badge, InfiniteScrollTrigger, LoadingState, SectionPanel } from "@homelab/ui";

import { TaskCard } from "./TaskCard";
import { taskStates } from "./taskPresentation";
import type { useTaskColumn } from "./useTaskColumn";

/**
 * Paginate one board column independently so a busy state cannot hide other tasks.
 * @returns Filtered tasks using the existing card, badge and loading components.
 */
export function TaskColumn({
    status,
    query,
    filtered,
    onSelect,
    disabled,
}: {
    readonly disabled: boolean;
    readonly query: ReturnType<typeof useTaskColumn>;
    readonly status: MiraTask["status"];
    readonly filtered: boolean;
    readonly onSelect: (task: MiraTask) => void;
}) {
    const { ref, isDropTarget } = useDroppable({
        id: `task-column:${status}`,
        type: "task-column",
        accept: "task-card",
        disabled,
    });
    const rows = query.data?.pages.flatMap((page) => page.rows) ?? [];
    return (
        <SectionPanel
            title={taskStates[status].title}
            icon={taskStates[status].icon}
            badge={
                <Badge>
                    {rows.length}
                    {query.hasNextPage ? "+" : ""}
                </Badge>
            }
        >
            <div
                ref={ref}
                className={`min-h-20 flex-1 space-y-2 rounded-lg transition-colors md:max-h-[calc(100dvh-19rem)] md:overflow-y-auto md:overscroll-contain md:pe-3 @min-[34rem]/task-board:min-h-44 @min-[64rem]/task-board:min-h-64 ${isDropTarget ? "bg-accent-900/30 ring-2 ring-accent-400 ring-inset" : ""}`}
            >
                {query.isPending && <LoadingState label="Loading tasks…" />}
                {rows.map((task) => (
                    <TaskCard
                        key={task.id}
                        task={task}
                        disabled={disabled}
                        onSelect={onSelect}
                    />
                ))}
                {!query.isPending && !query.isError && rows.length === 0 && (
                    <p className="py-2 text-sm text-primary-400">
                        {filtered ? "No matching tasks." : taskStates[status].empty}
                    </p>
                )}
                <InfiniteScrollTrigger
                    itemCount={query.data?.pages.length ?? 0}
                    hasMore={query.hasNextPage}
                    loading={query.isFetchingNextPage}
                    refreshing={query.isRefetching}
                    error={query.isError ? query.error : undefined}
                    onLoadMore={() =>
                        void (query.isRefetchError
                            ? query.refetch()
                            : query.fetchNextPage())
                    }
                />
            </div>
        </SectionPanel>
    );
}
