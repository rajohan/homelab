import { useDraggable } from "@dnd-kit/react";
import type { MiraTask } from "@homelab/contracts/mira";
import { IconButton } from "@homelab/ui";
import { GripVertical } from "lucide-react";

import { TaskCardContent } from "./TaskCardContent";

/**
 * Open a task from its card or move it with the dedicated pointer and keyboard handle.
 * @returns An accessible task card whose touch handle does not block column scrolling.
 */
export function TaskCard({
    task,
    disabled,
    onSelect,
}: {
    readonly task: MiraTask;
    readonly disabled: boolean;
    readonly onSelect: (task: MiraTask) => void;
}) {
    const { ref, handleRef, isDragging } = useDraggable({
        id: `task:${task.id}`,
        type: "task-card",
        data: { task },
        disabled,
    });
    return (
        <article
            ref={ref}
            className={`relative rounded-xl border border-primary-700 bg-primary-800 shadow-sm transition-colors hover:border-primary-500 ${isDragging ? "opacity-35" : "focus-within:border-accent-400"}`}
        >
            <button
                type="button"
                onClick={() => onSelect(task)}
                className="block w-full rounded-xl p-4 text-left focus-visible:outline-2 focus-visible:outline-accent-400"
                aria-label={`Open task: ${task.title}`}
            >
                <TaskCardContent task={task} />
            </button>
            <IconButton
                ref={handleRef}
                icon={GripVertical}
                label={`Move task: ${task.title}`}
                disabled={disabled}
                className={`absolute top-1 right-1 cursor-grab touch-none hover:bg-transparent active:cursor-grabbing active:bg-transparent ${isDragging ? "focus-visible:ring-0 focus-visible:ring-offset-0" : ""}`}
            />
        </article>
    );
}
