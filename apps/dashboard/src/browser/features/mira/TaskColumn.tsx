import { useDroppable } from "@dnd-kit/react";
import type { MiraTask } from "@homelab/contracts/mira";
import {
    Badge,
    Card,
    HeadingLabel,
    InfiniteScrollTrigger,
    LoadingState,
} from "@homelab/ui";
import { CornerDownLeft } from "lucide-react";
import { Fragment, useLayoutEffect, useRef } from "react";

import { TaskCard } from "./TaskCard";
import { TaskCardContent } from "./TaskCardContent";
import { taskDropIndex, taskStates } from "./taskPresentation";
import type { useTaskColumn } from "./useTaskColumn";

/**
 * Paginate one board column independently so a busy state cannot hide other tasks.
 * @returns Filtered tasks using the existing card, badge and loading components.
 */
export function TaskColumn({
    status,
    dragged,
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
    readonly dragged: MiraTask | undefined;
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
    const markerRef = useRef<HTMLDivElement>(null);
    const state = taskStates[status];
    const emptyMessage = filtered ? "No matching tasks." : state.empty;
    const targeted = isDropTarget && dragged !== undefined && dragged.status !== status;
    const insertion = targeted ? taskDropIndex(dragged, status, rows) : -1;
    const beyondPage =
        targeted && status !== "done" && insertion === rows.length && query.hasNextPage;
    const position =
        query.isPending || (query.isError && rows.length === 0) ? -1 : insertion;
    useLayoutEffect(() => {
        const scroll = scrollRef.current;
        const marker = markerRef.current;
        if (!scroll || !marker) return;
        const bounds = scroll.getBoundingClientRect();
        const gap = marker.getBoundingClientRect();
        if (gap.top < bounds.top + 12) scroll.scrollTop += gap.top - bounds.top - 12;
        else if (gap.bottom > bounds.bottom - 12)
            scroll.scrollTop += gap.bottom - bounds.bottom + 12;
    }, [position]);
    const marker = position >= 0 && dragged && (
        <div ref={markerRef} className="pointer-events-none shrink-0">
            {beyondPage ? (
                <output className="sr-only">Finding position in {state.title}</output>
            ) : (
                <>
                    <div
                        aria-hidden="true"
                        className="relative overflow-hidden rounded-lg border border-dashed border-accent-400/65 bg-accent-500/5"
                    >
                        <div className="invisible">
                            <TaskCardContent task={dragged} />
                        </div>
                        <span className="absolute inset-0 flex items-center justify-center gap-2 text-sm font-medium text-accent-300">
                            <CornerDownLeft size={16} />#{dragged.number}
                        </span>
                    </div>
                    <output className="sr-only">
                        {state.title}, position {position + 1}
                    </output>
                </>
            )}
        </div>
    );
    return (
        <Card
            ref={ref}
            aria-label={state.title}
            data-targeted={targeted || moving || undefined}
            aria-busy={moving || undefined}
            className="group/lane flex min-h-0 min-w-0 flex-col bg-surface-heading p-0 transition-colors duration-150 data-targeted:border-accent-400/60 motion-reduce:transition-none sm:p-0"
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
                className="flex max-h-[60dvh] min-h-0 flex-col gap-2.5 overflow-y-auto p-2.5 @min-[55rem]/task-board:max-h-none @min-[55rem]/task-board:flex-1 @min-[55rem]/task-board:overscroll-y-contain"
            >
                {query.isPending && <LoadingState label="Loading tasks…" />}
                {rows.map((task, index) => (
                    <Fragment key={task.id}>
                        {index === position && marker}
                        <TaskCard
                            task={task}
                            arrived={task.id === arrivedId}
                            disabled={disabled}
                            onSelect={onSelect}
                        />
                    </Fragment>
                ))}
                {position === rows.length && marker}
                {!targeted && !query.isPending && !query.isError && rows.length === 0 && (
                    <p className="grid min-h-16 flex-1 place-items-center rounded-lg border border-dashed border-primary-700 px-3 py-4 text-center text-sm text-primary-400">
                        {emptyMessage}
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
