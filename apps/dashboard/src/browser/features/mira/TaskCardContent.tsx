import type { MiraTask } from "@homelab/contracts/mira";
import { Badge, formatDateTime } from "@homelab/ui";
import { Bot, CalendarDays, UserRound } from "lucide-react";

import { taskPriorityTone } from "./taskPresentation";

/**
 * Present task metadata consistently in the board and its drag preview.
 * @returns A compact card body with priority, labels, assignment and due date.
 */
export function TaskCardContent({ task }: { readonly task: MiraTask }) {
    const AssigneeIcon = task.assignee === "mira" ? Bot : UserRound;
    return (
        <div className="space-y-3">
            <div className="flex flex-wrap gap-1.5 pr-10">
                <Badge tone={taskPriorityTone(task.priority)}>{task.priority}</Badge>
                {task.autoStart && <Badge>Auto start</Badge>}
            </div>
            <p className="line-clamp-3 text-sm font-semibold wrap-anywhere text-primary-100">
                {task.title}
            </p>
            {task.description && (
                <p className="line-clamp-2 text-xs leading-5 wrap-anywhere text-primary-400">
                    {task.description}
                </p>
            )}
            {task.labels.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                    {task.labels.slice(0, 3).map((label) => (
                        <Badge key={label}>{label}</Badge>
                    ))}
                    {task.labels.length > 3 && (
                        <span className="text-xs text-primary-400">
                            +{task.labels.length - 3}
                        </span>
                    )}
                </div>
            )}
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
