import type { MiraTask } from "@homelab/contracts/mira";
import {
    FormField,
    ActionGroup,
    Badge,
    Button,
    buttonStyles,
    ConfirmDialog,
    ErrorNotice,
    formatDateTime,
    Markdown,
    Modal,
    Textarea,
    SectionHeader,
} from "@homelab/ui";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
    Pencil,
    Trash2,
    FileText,
    ListChecks,
    History,
    MessageSquare,
    CalendarDays,
    UserRound,
    Flag,
} from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { TaskExecution } from "./TaskExecution";
import { taskStates, taskPriorityTone } from "./taskPresentation";
import { TaskRunDialog } from "./TaskRunDialog";

/**
 * Inspect task requirements and attributed progress without inventing execution state.
 * @returns Task details, linked conversation and an append-only progress composer.
 */
export function TaskDetail({
    task: initialTask,
    onEdit,
    onClose,
}: {
    readonly task: MiraTask;
    readonly onEdit: (task: MiraTask) => void;
    readonly onClose: () => void;
}) {
    const navigate = useNavigate();
    const current = useQuery({
        queryKey: ["operations", "mira", "task", initialTask.id, "detail"],
        queryFn: ({ signal }) =>
            api.mira.tasks.read.query({ id: initialTask.id }, { signal }),
        refetchInterval: 5000,
    });
    const task = current.data ?? initialTask;
    const [progress, setProgress] = useState("");
    const [deleting, setDeleting] = useState(false);
    const [starting, setStarting] = useState<{
        version: number;
        reviewRunId: string | null;
    }>();
    const query = useInfiniteQuery({
        queryKey: ["operations", "mira", "task", task.id, "progress"],
        initialPageParam: undefined as string | undefined,
        queryFn: ({ pageParam }) =>
            api.mira.tasks.progress.query({
                id: task.id,
                ...(pageParam ? { before: pageParam } : {}),
            }),
        getNextPageParam: (page) => page.nextCursor ?? undefined,
    });
    const add = useOperation(
        () => api.mira.tasks.addProgress.mutate({ taskId: task.id, text: progress }),
        () => setProgress("")
    );
    const remove = useOperation(() =>
        api.mira.tasks.delete.mutate({ id: task.id, version: task.version })
    );
    if (starting)
        return (
            <TaskRunDialog
                id={task.id}
                title={task.title}
                version={starting.version}
                reviewRunId={starting.reviewRunId}
                onClose={() => setStarting(undefined)}
                onStarted={(conversationId) => {
                    onClose();
                    void navigate({
                        to: "/mira/$conversationId",
                        params: { conversationId },
                    });
                }}
            />
        );
    if (deleting)
        return (
            <ConfirmDialog
                title="Delete task"
                description="Remove task content and progress. Historical runs retain an audit reference."
                onClose={() => setDeleting(false)}
                confirmLabel="Delete task"
                onConfirm={async () => {
                    await remove.mutateAsync(undefined);
                    onClose();
                }}
            />
        );
    return (
        <Modal
            title={task.title}
            titleAccessory={
                <>
                    <Badge>{taskStates[task.status].title}</Badge>
                    {task.autoStart && <Badge>Auto start</Badge>}
                </>
            }
            onClose={onClose}
            size="wide"
        >
            <div className="space-y-4">
                <div className="grid gap-3 rounded-xl border border-primary-700 bg-primary-900/40 p-4 sm:grid-cols-3">
                    <div className="space-y-2">
                        <p className="flex items-center gap-2 text-xs text-primary-400">
                            <UserRound size={14} aria-hidden="true" />
                            Assigned to
                        </p>
                        <p className="text-sm text-primary-100">
                            {task.assignee === "mira" ? "Mira" : "You"}
                        </p>
                    </div>
                    <div className="space-y-2">
                        <p className="flex items-center gap-2 text-xs text-primary-400">
                            <Flag size={14} aria-hidden="true" />
                            Priority
                        </p>
                        <Badge tone={taskPriorityTone(task.priority)}>
                            {task.priority}
                        </Badge>
                    </div>
                    <div className="space-y-2">
                        <p className="flex items-center gap-2 text-xs text-primary-400">
                            <CalendarDays size={14} aria-hidden="true" />
                            Due date
                        </p>
                        <p className="text-sm text-primary-100">
                            {task.dueAt ? formatDateTime(task.dueAt) : "No due date"}
                        </p>
                    </div>
                </div>
                {task.labels.length > 0 && (
                    <div className="flex flex-wrap gap-2">
                        {task.labels.map((label) => (
                            <Badge key={label}>{label}</Badge>
                        ))}
                    </div>
                )}
                <ActionGroup stretch={false}>
                    <Button
                        variant="secondary"
                        onClick={() => onEdit(task)}
                        disabled={current.isError}
                    >
                        <Pencil size={16} aria-hidden="true" />
                        Edit task
                    </Button>
                    {task.conversationId && (
                        <Link
                            to="/mira/$conversationId"
                            params={{ conversationId: task.conversationId }}
                            className={buttonStyles({ variant: "secondary" })}
                        >
                            <MessageSquare size={16} aria-hidden="true" />
                            Open conversation
                        </Link>
                    )}
                    <Button
                        variant="secondary"
                        onClick={() => setDeleting(true)}
                        disabled={current.isError}
                    >
                        <Trash2 size={16} aria-hidden="true" />
                        Delete task
                    </Button>
                </ActionGroup>
                {current.error && <ErrorNotice error={current.error} />}
                <section className="space-y-3 border-t border-primary-700 pt-4">
                    <SectionHeader title="Description" icon={FileText} />
                    <Markdown>{task.description || "No description."}</Markdown>
                </section>
                {task.completionCriteria && (
                    <section className="space-y-3 rounded-xl border border-primary-700 bg-primary-900/40 p-4">
                        <SectionHeader title="Completion criteria" icon={ListChecks} />
                        <Markdown>{task.completionCriteria}</Markdown>
                    </section>
                )}
                <TaskExecution
                    id={task.id}
                    canStart={
                        task.assignee === "mira" &&
                        task.status !== "done" &&
                        task.status !== "blocked"
                    }
                    onStart={(version, reviewRunId) =>
                        setStarting({ version, reviewRunId })
                    }
                />
                <section className="space-y-3">
                    <SectionHeader title="Progress" icon={History} />
                    {query.data?.pages
                        .flatMap((page) => page.rows)
                        .map((entry) => (
                            <article
                                key={entry.id}
                                className="space-y-2 rounded-lg border border-primary-700 bg-primary-900/40 p-3"
                            >
                                <p className="text-xs text-primary-400">
                                    {entry.actor.startsWith("mira:") ? "Mira" : "You"} ·{" "}
                                    {formatDateTime(entry.createdAt)}
                                </p>
                                <Markdown>{entry.content}</Markdown>
                            </article>
                        ))}
                    {query.hasNextPage && (
                        <Button
                            variant="secondary"
                            fullWidth
                            busy={query.isFetchingNextPage}
                            onClick={() => void query.fetchNextPage()}
                        >
                            Older progress
                        </Button>
                    )}
                    {query.error && <ErrorNotice error={query.error} />}
                    <FormField label="Add progress">
                        <Textarea
                            value={progress}
                            maxLength={4000}
                            onChange={(event) => setProgress(event.target.value)}
                        />
                    </FormField>
                    {add.error && <ErrorNotice error={add.error} />}
                    <ActionGroup stretch={false}>
                        <Button
                            disabled={!progress.trim()}
                            busy={add.isPending}
                            onClick={() => add.mutate(undefined)}
                        >
                            Add progress
                        </Button>
                    </ActionGroup>
                </section>
            </div>
        </Modal>
    );
}
