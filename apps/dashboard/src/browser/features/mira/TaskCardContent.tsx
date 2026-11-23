import type { MiraTask } from "@homelab/contracts/mira";
import { Badge, formatDateTime } from "@homelab/ui";
import { Bot, CalendarDays, GripVertical, UserRound } from "lucide-react";

import { taskPriorityTone } from "./taskPresentation";

/**
 * Present task metadata consistently in the board and its drag preview.
 * @returns A compact card body with priority, labels, assignment and due date.
 */
export function TaskCardContent({ task }: { readonly task: MiraTask }) {
    const AssigneeIcon = task.assignee === "mira" ? Bot : UserRound;
    const completed = task.status === "done" && task.completedAt;
    const timestamp = completed || task.updatedAt;
    return (
        <div className="space-y-2.5 p-3">
            <div className="flex items-start justify-between gap-2">
                <p className="line-clamp-3 min-w-0 text-sm font-semibold wrap-anywhere text-primary-50">
                    <span className="me-1.5 font-normal text-primary-400 tabular-nums">
                        #{task.number}
                    </span>
                    {task.title}
                </p>
                <GripVertical
                    aria-hidden="true"
                    size={20}
                    className="pointer-events-none shrink-0 text-primary-400"
                />
            </div>
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
            {task.dueAt && (
                <time
                    dateTime={task.dueAt}
                    className="flex items-center gap-1.5 text-xs text-primary-300"
                >
                    <CalendarDays size={14} aria-hidden="true" className="shrink-0" />
                    Due {formatDateTime(task.dueAt)}
                </time>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-primary-700/60 pt-3 text-xs text-primary-400">
                <span className="inline-flex items-center gap-1.5">
                    <AssigneeIcon size={14} aria-hidden="true" />
                    {task.assignee === "mira" ? "Mira" : "You"}
                </span>
                <time
                    dateTime={timestamp}
                    title={`${completed ? "Completed" : "Updated"} ${formatDateTime(timestamp)}`}
                >
                    {new Intl.DateTimeFormat("en-GB", {
                        day: "numeric",
                        month: "short",
                    }).format(new Date(timestamp))}
                </time>
            </div>
        </div>
    );
}
