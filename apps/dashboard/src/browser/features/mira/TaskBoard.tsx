import {
    DragDropProvider,
    DragOverlay,
    KeyboardSensor,
    PointerSensor,
} from "@dnd-kit/react";
import { miraTaskStates, type MiraTask } from "@homelab/contracts/mira";
import { ErrorNotice } from "@homelab/ui";
import { useState } from "react";
import * as v from "valibot";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { TaskCardContent } from "./TaskCardContent";
import { TaskColumn } from "./TaskColumn";
import { taskDragSchema, taskMoveForDrop } from "./taskPresentation";

const sensors = [PointerSensor, KeyboardSensor.configure({ offset: 40 })];

/**
 * Move tasks across independently paginated columns with conflict-safe server updates.
 * @returns A pointer, touch and keyboard board with visible mutation failures.
 */
export function TaskBoard({
    search,
    assignee,
    onSelect,
}: {
    readonly search: string;
    readonly assignee: MiraTask["assignee"] | "all";
    readonly onSelect: (task: MiraTask) => void;
}) {
    const [dragged, setDragged] = useState<MiraTask>();
    const move = useOperation((input: NonNullable<ReturnType<typeof taskMoveForDrop>>) =>
        api.mira.tasks.update.mutate(input)
    );
    return (
        <div className="space-y-4">
            {move.error && <ErrorNotice error={move.error} />}
            <DragDropProvider
                sensors={sensors}
                onDragStart={({ operation }) => {
                    const parsed = v.safeParse(
                        taskDragSchema,
                        operation.source?.data.task
                    );
                    setDragged(parsed.success ? parsed.output : undefined);
                }}
                onDragEnd={({ canceled, operation }) => {
                    if (!canceled && !move.isPending) {
                        const input = taskMoveForDrop(dragged, operation.target?.id);
                        if (input) move.mutate(input);
                    }
                    setDragged(undefined);
                }}
            >
                <div className="grid min-w-0 gap-4 md:grid-cols-2 xl:grid-cols-4">
                    {miraTaskStates.map((status) => (
                        <TaskColumn
                            key={status}
                            status={status}
                            search={search}
                            assignee={assignee}
                            onSelect={onSelect}
                            disabled={move.isPending}
                        />
                    ))}
                </div>
                <DragOverlay>
                    {dragged && (
                        <div className="w-72 rounded-xl border border-accent-400 bg-primary-800 p-4 shadow-xl shadow-black/40">
                            <TaskCardContent task={dragged} />
                        </div>
                    )}
                </DragOverlay>
            </DragDropProvider>
        </div>
    );
}
