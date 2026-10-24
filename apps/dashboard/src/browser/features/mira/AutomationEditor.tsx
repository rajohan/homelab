import type { MiraAutomation, MiraSchedule } from "@homelab/contracts/mira";
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
    Textarea,
    TimePicker,
} from "@homelab/ui";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";

/**
 * Edit a bounded Mira automation while preserving its independently saved pause state.
 * @returns A shared responsive editor for interval, daily, cron, event and one-time work.
 */
export function AutomationEditor({
    automation,
    onClose,
}: {
    readonly automation?: MiraAutomation | undefined;
    readonly onClose: () => void;
}) {
    const [title, setTitle] = useState(automation?.title ?? "");
    const [prompt, setPrompt] = useState(automation?.prompt ?? "");
    const [delivery, setDelivery] = useState<MiraAutomation["delivery"]>(
        automation?.delivery ?? "changes"
    );
    const [schedule, setSchedule] = useState<MiraSchedule>(
        automation?.schedule ?? { kind: "daily", time: "07:30" }
    );
    const [once, setOnce] = useState(() =>
        dateTimePickerValue(
            automation?.schedule.kind === "once"
                ? automation.schedule.at
                : Date.now() + 3_600_000
        )
    );
    const [budget, setBudget] = useState(String(automation?.budgetSeconds ?? 180));
    const save = useOperation(() => {
        const input = {
            title,
            prompt,
            delivery,
            schedule:
                schedule.kind === "once"
                    ? {
                          kind: "once" as const,
                          at: new Date(dateTimePickerTimestamp(once)).toISOString(),
                      }
                    : schedule,
            budgetSeconds: Number(budget),
            kind: automation?.kind ?? ("custom" as const),
        };
        return automation
            ? api.mira.automations.update.mutate({
                  ...input,
                  id: automation.id,
                  version: automation.version,
              })
            : api.mira.automations.create.mutate(input);
    });
    return (
        <Modal
            title={automation ? "Edit automation" : "New automation"}
            onClose={onClose}
            size="wide"
            dismissible={!save.isPending}
        >
            <form
                className="space-y-4"
                onSubmit={(event) => {
                    event.preventDefault();
                    void save
                        .mutateAsync(undefined)
                        .then(onClose)
                        .catch(() => {});
                }}
            >
                <FormField label="Title">
                    <Input
                        required
                        maxLength={160}
                        value={title}
                        onChange={(event) => setTitle(event.target.value)}
                    />
                </FormField>
                <FormField label="Instructions">
                    <Textarea
                        required
                        maxLength={32_000}
                        value={prompt}
                        onChange={(event) => setPrompt(event.target.value)}
                        rows={6}
                    />
                </FormField>
                <Fieldset legend="Schedule">
                    <Select
                        label="Schedule type"
                        value={schedule.kind}
                        options={[
                            { value: "daily", label: "Daily" },
                            { value: "interval", label: "Interval" },
                            { value: "cron", label: "Cron" },
                            { value: "once", label: "Once" },
                            { value: "event", label: "Event" },
                        ]}
                        onChange={(kind) => {
                            if (kind === "daily") setSchedule({ kind, time: "07:30" });
                            else if (kind === "interval")
                                setSchedule({ kind, intervalSeconds: 1800 });
                            else if (kind === "cron")
                                setSchedule({ kind, expression: "30 9,18 * * *" });
                            else if (kind === "once")
                                setSchedule({
                                    kind,
                                    at: new Date(Date.now() + 3_600_000).toISOString(),
                                });
                            else setSchedule({ kind, event: "task_due" });
                        }}
                    />
                </Fieldset>
                {schedule.kind === "daily" && (
                    <TimePicker
                        label="Daily time · Europe/Oslo"
                        value={schedule.time}
                        onChange={(time) => setSchedule({ kind: "daily", time })}
                    />
                )}
                {schedule.kind === "interval" && (
                    <FormField label="Interval in minutes">
                        <Input
                            type="number"
                            min={1}
                            max={43_200}
                            value={schedule.intervalSeconds / 60}
                            onChange={(event) =>
                                setSchedule({
                                    kind: "interval",
                                    intervalSeconds: Number(event.target.value) * 60,
                                })
                            }
                        />
                    </FormField>
                )}
                {schedule.kind === "cron" && (
                    <FormField label="Five-field cron · Europe/Oslo">
                        <Input
                            value={schedule.expression}
                            maxLength={200}
                            onChange={(event) =>
                                setSchedule({
                                    kind: "cron",
                                    expression: event.target.value,
                                })
                            }
                        />
                    </FormField>
                )}
                {schedule.kind === "once" && (
                    <DateTimePicker label="Run at" value={once} onChange={setOnce} />
                )}
                {schedule.kind === "event" && (
                    <Fieldset legend="Event">
                        <Select
                            label="Trigger event"
                            value={schedule.event}
                            options={[
                                { value: "agentmail", label: "AgentMail message" },
                                { value: "task_due", label: "Task due" },
                            ]}
                            onChange={(event) => setSchedule({ kind: "event", event })}
                        />
                    </Fieldset>
                )}
                <Fieldset legend="Notifications">
                    <Select
                        label="Report notifications"
                        value={delivery}
                        options={[
                            { value: "changes", label: "When recorded state changes" },
                            { value: "reports", label: "Every new report" },
                            { value: "silent", label: "Silent" },
                        ]}
                        onChange={setDelivery}
                    />
                    <p className="text-sm text-primary-400">
                        Reports stay in the dashboard. Silent also suppresses this
                        automation&apos;s failure notifications.
                    </p>
                </Fieldset>
                <FormField label="Maximum run time in seconds">
                    <Input
                        required
                        type="number"
                        min={30}
                        max={900}
                        value={budget}
                        onChange={(event) => setBudget(event.target.value)}
                    />
                </FormField>
                {save.error && <ErrorNotice error={save.error} />}
                <ActionGroup>
                    <Button
                        type="submit"
                        busy={save.isPending}
                        disabled={!title.trim() || !prompt.trim()}
                    >
                        Save automation
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
