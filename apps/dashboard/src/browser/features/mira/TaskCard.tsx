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
    arrived,
    disabled,
    onSelect,
}: {
    readonly task: MiraTask;
    readonly arrived: boolean;
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
            data-dragging={isDragging || undefined}
            data-arrived={arrived || undefined}
            className="motion-safe:data-arrived:animate-task-arrive relative shrink-0 rounded-lg border border-primary-700 bg-primary-800 shadow-sm shadow-black/25 transition-colors duration-150 focus-within:border-accent-400 hover:border-primary-500 data-dragging:border-dashed data-dragging:border-primary-500 data-dragging:bg-transparent data-dragging:shadow-none motion-reduce:transition-none data-dragging:[&>button]:opacity-35"
        >
            <button
                type="button"
                onClick={() => onSelect(task)}
                className="block w-full cursor-pointer rounded-lg text-left focus-visible:outline-2 focus-visible:outline-accent-400"
                aria-label={`Open task: ${task.title}`}
            >
                <TaskCardContent task={task} />
            </button>
            <IconButton
                ref={handleRef}
                icon={GripVertical}
                label={`Move task: ${task.title}`}
                disabled={disabled}
                className="absolute top-0.5 right-0.5 cursor-grab touch-none text-primary-400 hover:bg-primary-700 hover:text-primary-100 active:cursor-grabbing"
            />
        </article>
    );
}
