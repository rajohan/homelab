import type { MiraTask } from "@homelab/contracts/mira";
import { Badge, formatDateTime } from "@homelab/ui";
import { Bot, CalendarDays, GripVertical, UserRound } from "lucide-react";

import { taskPriorityTone } from "./taskPresentation";

/**
 * Present task metadata consistently in the board and its drag preview.
 * @returns A compact card body with priority, labels, assignment and due date.
 */
export function TaskCardContent({
    task,
    preview = false,
}: {
    readonly task: MiraTask;
    readonly preview?: boolean;
}) {
    const AssigneeIcon = task.assignee === "mira" ? Bot : UserRound;
    return (
        <div className="space-y-2.5 p-3">
            {preview && (
                <span
                    aria-hidden="true"
                    className="absolute top-0.5 right-0.5 grid size-11 place-items-center text-accent-300"
                >
                    <GripVertical size={20} />
                </span>
            )}
            <p className="line-clamp-3 pe-8 text-sm font-semibold wrap-anywhere text-primary-50">
                {task.title}
            </p>
            {task.description && (
                <p className="line-clamp-2 text-xs leading-5 wrap-anywhere text-primary-400">
                    {task.description}
                </p>
            )}
            <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={taskPriorityTone(task.priority)}>{task.priority}</Badge>
                {task.autoStart && <Badge tone="info">Auto start</Badge>}
                {task.labels.slice(0, 3).map((label) => (
                    <Badge key={label}>{label}</Badge>
                ))}
                {task.labels.length > 3 && (
                    <span className="text-xs text-primary-400">
                        +{task.labels.length - 3}
                    </span>
                )}
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-primary-700/60 pt-3 text-xs text-primary-400">
                <span className="inline-flex items-center gap-1.5">
                    <AssigneeIcon size={14} aria-hidden="true" />
                    {task.assignee === "mira" ? "Mira" : "You"}
                </span>
                <time dateTime={task.updatedAt} title={formatDateTime(task.updatedAt)}>
                    {new Intl.DateTimeFormat("en-GB", {
                        day: "numeric",
                        month: "short",
                    }).format(new Date(task.updatedAt))}
                </time>
            </div>
            {task.dueAt && (
                <span className="flex items-center gap-1.5 text-xs text-primary-300">
                    <CalendarDays size={14} aria-hidden="true" />
                    Due {formatDateTime(task.dueAt)}
                </span>
            )}
        </div>
    );
}
