import type { MiraTask } from "@homelab/contracts/mira";
import {
    ActionGroup,
    Badge,
    Button,
    buttonStyles,
    ConfirmDialog,
    DetailFacts,
    DetailSection,
    ErrorNotice,
    formatDateTime,
    FormField,
    InfiniteScrollTrigger,
    Markdown,
    Modal,
    Textarea,
} from "@homelab/ui";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import {
    Activity,
    Bot,
    CalendarDays,
    FileText,
    Flag,
    ListChecks,
    ListTodo,
    MessageSquare,
    Pencil,
    Trash2,
    UserRound,
} from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { miraStatusTone } from "./statusTone";
import { TaskExecution } from "./TaskExecution";
import { taskPriorityTone, taskStates } from "./taskPresentation";
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
    const [deleting, setDeleting] = useState<number>();
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
    const remove = useOperation((version: number) =>
        api.mira.tasks.delete.mutate({ id: task.id, version })
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
    if (deleting !== undefined)
        return (
            <ConfirmDialog
                title="Delete task"
                description="Remove task content and progress. Historical runs retain an audit reference."
                onClose={() => setDeleting(undefined)}
                confirmLabel="Delete task"
                onConfirm={async () => {
                    await remove.mutateAsync(deleting);
                    onClose();
                }}
            />
        );
    return (
        <Modal
            title={`#${task.number} ${task.title}`}
            titleAccessory={
                <>
                    <Badge tone={miraStatusTone(task.status)}>
                        {taskStates[task.status].title}
                    </Badge>
                    {task.autoStart && <Badge tone="info">Auto start</Badge>}
                </>
            }
            onClose={onClose}
            size="wide"
        >
            <div className="space-y-4">
                <DetailSection icon={ListTodo} title="Task details">
                    <DetailFacts
                        layout="properties"
                        items={[
                            {
                                label: "Assigned to",
                                icon: task.assignee === "mira" ? Bot : UserRound,
                                value: task.assignee === "mira" ? "Mira" : "You",
                            },
                            {
                                label: "Priority",
                                icon: Flag,
                                value:
                                    taskPriorityTone(task.priority) === "neutral" ? (
                                        <span className="capitalize">
                                            {task.priority}
                                        </span>
                                    ) : (
                                        <Badge
                                            tone={taskPriorityTone(task.priority)}
                                            className="capitalize"
                                        >
                                            {task.priority}
                                        </Badge>
                                    ),
                            },
                            {
                                label: "Due date",
                                icon: CalendarDays,
                                value: task.dueAt ? (
                                    <time dateTime={task.dueAt}>
                                        {formatDateTime(task.dueAt)}
                                    </time>
                                ) : (
                                    <span className="font-normal text-primary-400">
                                        No due date
                                    </span>
                                ),
                            },
                        ]}
                    />
                    {task.labels.length > 0 && (
                        <div className="flex flex-wrap gap-2">
                            {task.labels.map((label) => (
                                <Badge key={label}>{label}</Badge>
                            ))}
                        </div>
                    )}
                    <ActionGroup stretch={false} align="start">
                        <Button
                            variant="danger"
                            onClick={() => setDeleting(task.version)}
                            disabled={current.isError}
                        >
                            <Trash2 size={16} aria-hidden="true" />
                            Delete task
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
                            variant="primary"
                            onClick={() => onEdit(task)}
                            disabled={current.isError}
                        >
                            <Pencil size={16} aria-hidden="true" />
                            Edit task
                        </Button>
                    </ActionGroup>
                </DetailSection>
                {current.error && <ErrorNotice error={current.error} />}
                <DetailSection icon={FileText} title="Description">
                    <Markdown>{task.description || "No description."}</Markdown>
                </DetailSection>
                {task.completionCriteria && (
                    <DetailSection icon={ListChecks} title="Completion criteria">
                        <Markdown>{task.completionCriteria}</Markdown>
                    </DetailSection>
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
                <DetailSection icon={Activity} title="Progress">
                    {query.data?.pages
                        .flatMap((page) => page.rows)
                        .map((entry) => (
                            <article
                                key={entry.id}
                                className="space-y-2 border-b border-primary-700 pb-3"
                            >
                                <p className="text-xs text-primary-400">
                                    {entry.actor.startsWith("mira:") ? "Mira" : "You"} ·{" "}
                                    {formatDateTime(entry.createdAt)}
                                </p>
                                <Markdown>{entry.content}</Markdown>
                            </article>
                        ))}
                    <InfiniteScrollTrigger
                        itemCount={query.data?.pages.length ?? 0}
                        hasMore={query.hasNextPage}
                        loading={query.isFetchingNextPage}
                        refreshing={query.isRefetching}
                        error={query.isError ? query.error : undefined}
                        onLoadMore={() =>
                            void (query.isRefetchError
                                ? query.refetch()
                                : query.fetchNextPage())
                        }
                    />
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
                </DetailSection>
            </div>
        </Modal>
    );
}
