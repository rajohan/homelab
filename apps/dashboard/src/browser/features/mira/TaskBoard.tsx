import {
    DragDropProvider,
    DragOverlay,
    KeyboardSensor,
    PointerSensor,
} from "@dnd-kit/react";
import { type MiraTask, miraTaskStates } from "@homelab/contracts/mira";
import { ErrorNotice } from "@homelab/ui";
import { useState } from "react";
import * as v from "valibot";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { TaskCardContent } from "./TaskCardContent";
import { TaskColumn } from "./TaskColumn";
import { taskDragSchema, taskMoveForDrop } from "./taskPresentation";
import type { useTaskColumn } from "./useTaskColumn";

const sensors = [PointerSensor, KeyboardSensor.configure({ offset: 40 })];

/**
 * Move tasks across independently paginated columns with conflict-safe server updates.
 * @returns A pointer, touch and keyboard board with visible mutation failures.
 */
export function TaskBoard({
    columns,
    search,
    assignee,
    onSelect,
}: {
    readonly columns: Record<MiraTask["status"], ReturnType<typeof useTaskColumn>>;
    readonly search: string;
    readonly assignee: MiraTask["assignee"] | "all";
    readonly onSelect: (task: MiraTask) => void;
}) {
    const [dragged, setDragged] = useState<MiraTask>();
    const [arrival, setArrival] = useState<Pick<MiraTask, "id" | "status">>();
    const move = useOperation((input: NonNullable<ReturnType<typeof taskMoveForDrop>>) =>
        api.mira.tasks.update.mutate(input)
    );
    return (
        <div className="@container/task-board space-y-4">
            {move.error && <ErrorNotice error={move.error} />}
            <DragDropProvider
                sensors={sensors}
                onDragStart={({ operation }) => {
                    setArrival(undefined);
                    const parsed = v.safeParse(
                        taskDragSchema,
                        operation.source?.data.task
                    );
                    setDragged(parsed.success ? parsed.output : undefined);
                }}
                onDragEnd={({ canceled, operation }) => {
                    if (!canceled && !move.isPending) {
                        const input = taskMoveForDrop(dragged, operation.target?.id);
                        if (input)
                            move.mutate(input, {
                                onSuccess: () =>
                                    setArrival({ id: input.id, status: input.status }),
                            });
                    }
                    setDragged(undefined);
                }}
            >
                <div
                    className="grid min-w-0 gap-3 @min-[34rem]/task-board:grid-cols-2 @min-[55rem]/task-board:grid-cols-4"
                    onAnimationEnd={(event) => {
                        if (event.animationName === "task-arrive") setArrival(undefined);
                    }}
                >
                    {miraTaskStates.map((status) => (
                        <TaskColumn
                            key={status}
                            status={status}
                            draggedFrom={dragged?.status}
                            arrivedId={
                                arrival?.status === status ? arrival.id : undefined
                            }
                            moving={move.isPending && move.variables?.status === status}
                            query={columns[status]}
                            filtered={Boolean(search) || assignee !== "all"}
                            onSelect={onSelect}
                            disabled={move.isPending}
                        />
                    ))}
                </div>
                <DragOverlay dropAnimation={null}>
                    {dragged && (
                        <div
                            aria-hidden="true"
                            className="relative w-full cursor-grabbing rounded-lg border border-accent-400 bg-primary-800 shadow-xl shadow-black/45 motion-safe:rotate-1"
                        >
                            <TaskCardContent task={dragged} preview />
                        </div>
                    )}
                </DragOverlay>
            </DragDropProvider>
        </div>
    );
}
