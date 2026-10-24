import {
    miraTaskStates,
    miraTaskUpdateSchema,
    type MiraTask,
} from "@homelab/contracts/mira";
import { Circle, CircleAlert, CircleCheck, CircleDot } from "lucide-react";
import * as v from "valibot";

export const taskStates = {
    todo: { title: "To do", icon: Circle },
    in_progress: { title: "In progress", icon: CircleDot },
    blocked: { title: "Blocked", icon: CircleAlert },
    done: { title: "Done", icon: CircleCheck },
};
export const taskDragSchema = v.object({
    ...miraTaskUpdateSchema.entries,
    createdAt: v.string(),
    updatedAt: v.string(),
});

/**
 * Validate a board drop and preserve the captured version for conflict detection.
 * @param task - Task snapshot captured when dragging begins.
 * @param target - Droppable column identifier, or an unrelated target.
 * @returns A strict update payload, or undefined for invalid and same-column drops.
 */
export function taskMoveForDrop(task: unknown, target: unknown) {
    const parsed = v.safeParse(taskDragSchema, task);
    const status = miraTaskStates.find((state) => target === `task-column:${state}`);
    if (!parsed.success || !status || parsed.output.status === status) return;
    return v.parse(v.object(miraTaskUpdateSchema.entries), { ...parsed.output, status });
}

/**
 * Give urgent and high-priority tasks their corresponding shared badge colors.
 * @param priority - Persisted task priority.
 * @returns A shared badge tone.
 */
export function taskPriorityTone(priority: MiraTask["priority"]) {
    if (priority === "urgent") return "danger";
    return priority === "high" ? "warning" : "neutral";
}
