import { useDroppable } from "@dnd-kit/react";
import type { MiraTask } from "@homelab/contracts/mira";
import {
    Badge,
    Card,
    HeadingLabel,
    InfiniteScrollTrigger,
    LoadingState,
} from "@homelab/ui";
import { Fragment, useLayoutEffect, useRef } from "react";

import { TaskCard } from "./TaskCard";
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
    const markerRef = useRef<HTMLOutputElement>(null);
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
    const marker = position >= 0 && (
        <output
            ref={markerRef}
            className="pointer-events-none relative flex h-2 shrink-0 items-center"
        >
            {beyondPage ? (
                <span className="sr-only">Finding position in {state.title}</span>
            ) : (
                <>
                    <span
                        aria-hidden="true"
                        className="size-2 shrink-0 rounded-full bg-accent-300"
                    />
                    <span
                        aria-hidden="true"
                        className="h-0.5 flex-1 rounded-r-full bg-accent-300"
                    />
                    <span className="sr-only">
                        {state.title}, position {position + 1}
                    </span>
                </>
            )}
        </output>
    );
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
