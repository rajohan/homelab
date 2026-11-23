import { useDroppable } from "@dnd-kit/react";
import type { MiraTask } from "@homelab/contracts/mira";
import {
    Badge,
    Card,
    HeadingLabel,
    InfiniteScrollTrigger,
    LoadingState,
} from "@homelab/ui";
import { useRef } from "react";

import { TaskCard } from "./TaskCard";
import { taskStates } from "./taskPresentation";
import type { useTaskColumn } from "./useTaskColumn";

/**
 * Paginate one board column independently so a busy state cannot hide other tasks.
 * @returns Filtered tasks using the existing card, badge and loading components.
 */
export function TaskColumn({
    status,
    draggedFrom,
    arrivedId,
    moving,
    query,
    filtered,
    onSelect,
    disabled,
}: {
    readonly disabled: boolean;
    readonly query: ReturnType<typeof useTaskColumn>;
    readonly status: MiraTask["status"];
    readonly draggedFrom: MiraTask["status"] | undefined;
    readonly arrivedId: string | undefined;
    readonly moving: boolean;
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
    const scrollRef = useRef<HTMLDivElement>(null);
    const state = taskStates[status];
    const emptyMessage = filtered ? "No matching tasks." : state.empty;
    const targeted = isDropTarget && draggedFrom !== undefined && draggedFrom !== status;
    return (
        <Card
            ref={ref}
            aria-label={state.title}
            data-targeted={targeted || moving || undefined}
            aria-busy={moving || undefined}
            className="group/lane flex min-h-0 min-w-0 flex-col bg-surface-heading p-0 transition-colors duration-150 data-targeted:border-accent-400 data-targeted:bg-accent-950 data-targeted:ring-1 data-targeted:ring-accent-400 motion-reduce:transition-none sm:p-0"
        >
            <header className="flex min-h-12 shrink-0 items-center justify-between gap-2 border-b border-primary-700 px-3 group-data-targeted/lane:border-accent-400/50">
                <h2 className="min-w-0 text-base leading-snug font-semibold text-primary-50">
                    <HeadingLabel icon={state.icon} size={16} className={state.iconClass}>
                        {state.title}
                    </HeadingLabel>
                </h2>
                {moving ? (
                    <Badge tone="info" className="shrink-0">
                        Moving…
                    </Badge>
                ) : (
                    <Badge className="shrink-0 tabular-nums">
                        {rows.length}
                        {query.hasNextPage ? "+" : ""}
                    </Badge>
                )}
            </header>
            <div
                ref={scrollRef}
                className="flex min-h-0 flex-1 flex-col gap-2.5 overflow-y-auto overscroll-y-contain p-2.5"
            >
                {query.isPending && <LoadingState label="Loading tasks…" />}
                {rows.map((task) => (
                    <TaskCard
                        key={task.id}
                        task={task}
                        arrived={task.id === arrivedId}
                        disabled={disabled}
                        onSelect={onSelect}
                    />
                ))}
                {!query.isPending && !query.isError && rows.length === 0 && (
                    <p className="grid min-h-16 flex-1 place-items-center rounded-lg border border-dashed border-primary-700 px-3 py-4 text-center text-sm text-primary-400 group-data-targeted/lane:border-accent-400 group-data-targeted/lane:text-accent-200">
                        <span className="group-data-targeted/lane:invisible">
                            {emptyMessage}
                        </span>
                    </p>
                )}
                <InfiniteScrollTrigger
                    rootRef={scrollRef}
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
        </Card>
    );
}
