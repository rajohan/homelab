import { useDraggable } from "@dnd-kit/react";
import type { MiraTask } from "@homelab/contracts/mira";

import { TaskCardContent } from "./TaskCardContent";

/**
 * Open a task on click or Enter and move it by dragging or pressing Space.
 * @returns A full-card drag surface with native button activation.
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
    const { ref, isDragging } = useDraggable({
        id: `task:${task.id}`,
        type: "task-card",
        data: { task },
        disabled,
    });
    return (
        <button
            ref={ref}
            type="button"
            aria-label={`Open task #${task.number}: ${task.title}`}
            title="Enter to open. Space and arrow keys to move."
            onClick={(event) => {
                if (!event.defaultPrevented) onSelect(task);
            }}
            data-dragging={isDragging || undefined}
            data-arrived={arrived || undefined}
            className="motion-safe:data-arrived:animate-task-arrive block w-full shrink-0 cursor-grab rounded-lg border border-primary-700 bg-primary-800 text-left shadow-sm shadow-black/25 transition-colors duration-150 select-none hover:border-primary-500 focus-visible:outline-2 focus-visible:outline-accent-400 active:cursor-grabbing data-dragging:border-dashed data-dragging:border-primary-500 data-dragging:bg-transparent data-dragging:shadow-none motion-reduce:transition-none data-dragging:[&>div]:opacity-35"
        >
            <TaskCardContent task={task} />
        </button>
    );
}
