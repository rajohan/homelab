import {
    type MiraTask,
    miraTaskInputSchema,
    miraTaskStates,
    miraTaskUpdateSchema,
} from "@homelab/contracts/mira";
import { Circle, CircleAlert, CircleCheck, CircleDot } from "lucide-react";
import * as v from "valibot";

export const taskStates = {
    todo: {
        title: "To do",
        empty: "Nothing queued.",
        icon: Circle,
        iconClass: "[&>svg]:text-primary-400",
    },
    in_progress: {
        title: "In progress",
        empty: "No tasks in progress.",
        icon: CircleDot,
        iconClass: "[&>svg]:text-accent-300",
    },
    blocked: {
        title: "Blocked",
        empty: "No blocked tasks.",
        icon: CircleAlert,
        iconClass: "[&>svg]:text-amber-300",
    },
    done: {
        title: "Done",
        empty: "No completed tasks.",
        icon: CircleCheck,
        iconClass: "[&>svg]:text-emerald-300",
    },
};
export const taskDragSchema = v.object({
    ...miraTaskUpdateSchema.entries,
    number: v.pipe(v.number(), v.integer(), v.minValue(1)),
    completedAt: v.optional(v.nullable(v.string()), null),
    createdAt: v.string(),
    updatedAt: v.string(),
});

// PostgreSQL keeps microseconds. Preserve them when two tasks share a millisecond.
function creationTime(task: MiraTask): number {
    const fraction = task.createdAt.match(/\.\d{3}(\d{1,3})/)?.[1] ?? "";
    const iso = task.createdAt.replace(" ", "T").replace(/([+-]\d{2})$/, "$1:00");
    return Date.parse(iso) * 1000 + Number(fraction.padEnd(3, "0"));
}

/**
 * Locate a moved task in the destination's server-ordered cards.
 * @param dragged - Task captured at drag start.
 * @param status - Destination column, which determines the ordering.
 * @param rows - Loaded cards in display order.
 * @returns The gap before a card, or the end of the loaded page.
 */
export function taskDropIndex(
    dragged: MiraTask,
    status: MiraTask["status"],
    rows: readonly MiraTask[]
): number {
    if (status === "done") return 0;
    const priorities = miraTaskInputSchema.entries.priority.options;
    const rank = priorities.indexOf(dragged.priority);
    const time = creationTime(dragged);
    const index = rows.findIndex((row) => {
        const rowRank = priorities.indexOf(row.priority);
        if (rank !== rowRank) return rank > rowRank;
        const rowTime = creationTime(row);
        return time === rowTime ? dragged.id > row.id : time > rowTime;
    });
    return index === -1 ? rows.length : index;
}

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
