import type { MiraTask, MiraTaskInput } from "@homelab/contracts/mira";
import {
    FormField,
    ActionGroup,
    Button,
    DateTimePicker,
    dateTimePickerTimestamp,
    dateTimePickerValue,
    ErrorNotice,
    Fieldset,
    Input,
    Modal,
    Select,
    Switch,
    Textarea,
} from "@homelab/ui";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";

/**
 * Create or edit a task using shared fields and explicit completion criteria.
 * @returns A viewport-bounded editor with optimistic concurrency on saved changes.
 */
export function TaskEditor({
    task,
    onClose,
}: {
    readonly task?: MiraTask | undefined;
    readonly onClose: () => void;
}) {
    const [value, setValue] = useState<MiraTaskInput>(
        () =>
            task ?? {
                title: "",
                description: "",
                status: "todo",
                assignee: "mira",
                priority: "normal",
                labels: [],
                dueAt: null,
                completionCriteria: "",
                conversationId: null,
            }
    );
    const [labels, setLabels] = useState(task?.labels.join(", ") ?? "");
    const [hasDue, setHasDue] = useState(Boolean(task?.dueAt));
    const [due, setDue] = useState(() =>
        dateTimePickerValue(task?.dueAt ?? Date.now() + 86_400_000)
    );
    const save = useOperation((input: MiraTaskInput) =>
        task
            ? api.mira.tasks.update.mutate({
                  ...input,
                  id: task.id,
                  version: task.version,
              })
            : api.mira.tasks.create.mutate(input)
    );
    return (
        <Modal
            title={task ? "Edit task" : "New task"}
            onClose={onClose}
            dismissible={!save.isPending}
            size="wide"
        >
            <form
                className="space-y-4"
                onSubmit={(event) => {
                    event.preventDefault();
                    void save
                        .mutateAsync({
                            ...value,
                            labels: labels
                                .split(",")
                                .map((label) => label.trim())
                                .filter(Boolean),
                            dueAt: hasDue
                                ? new Date(dateTimePickerTimestamp(due)).toISOString()
                                : null,
                        })
                        .then(onClose)
                        .catch(() => {});
                }}
            >
                <FormField label="Title">
                    <Input
                        required
                        maxLength={160}
                        value={value.title}
                        onChange={(event) =>
                            setValue({ ...value, title: event.target.value })
                        }
                    />
                </FormField>
                <FormField label="Description">
                    <Textarea
                        value={value.description}
                        maxLength={32_000}
                        onChange={(event) =>
                            setValue({ ...value, description: event.target.value })
                        }
                    />
                </FormField>
                <div className="grid gap-4 sm:grid-cols-3">
                    <Fieldset legend="Status">
                        <Select
                            label="Task status"
                            value={value.status}
                            options={[
                                { value: "todo", label: "To do" },
                                { value: "in_progress", label: "In progress" },
                                { value: "blocked", label: "Blocked" },
                                { value: "done", label: "Done" },
                            ]}
                            onChange={(status) => setValue({ ...value, status })}
                        />
                    </Fieldset>
                    <Fieldset legend="Assigned to">
                        <Select
                            label="Task assignee"
                            value={value.assignee}
                            options={[
                                { value: "mira", label: "Mira" },
                                { value: "operator", label: "You" },
                            ]}
                            onChange={(assignee) => setValue({ ...value, assignee })}
                        />
                    </Fieldset>
                    <Fieldset legend="Priority">
                        <Select
                            label="Task priority"
                            value={value.priority}
                            options={[
                                { value: "low", label: "Low" },
                                { value: "normal", label: "Normal" },
                                { value: "high", label: "High" },
                                { value: "urgent", label: "Urgent" },
                            ]}
                            onChange={(priority) => setValue({ ...value, priority })}
                        />
                    </Fieldset>
                </div>
                <FormField label="Completion criteria">
                    <Textarea
                        value={value.completionCriteria}
                        maxLength={4000}
                        onChange={(event) =>
                            setValue({ ...value, completionCriteria: event.target.value })
                        }
                        placeholder="What must be true before this task is done?"
                    />
                </FormField>
                <FormField label="Labels, separated by commas">
                    <Input
                        value={labels}
                        onChange={(event) => setLabels(event.target.value)}
                    />
                </FormField>
                <Switch label="Due date" checked={hasDue} onChange={setHasDue} />
                {hasDue && (
                    <DateTimePicker label="Due at" value={due} onChange={setDue} />
                )}
                {save.error && <ErrorNotice error={save.error} />}
                <ActionGroup>
                    <Button
                        type="submit"
                        busy={save.isPending}
                        disabled={
                            !value.title.trim() ||
                            (hasDue && !Number.isFinite(dateTimePickerTimestamp(due)))
                        }
                    >
                        Save task
                    </Button>
                    <Button
                        variant="secondary"
                        onClick={onClose}
                        disabled={save.isPending}
                    >
                        Cancel
                    </Button>
                </ActionGroup>
            </form>
        </Modal>
    );
}
