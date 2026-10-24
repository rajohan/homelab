import type { MiraAutomation, MiraSwitch } from "@homelab/contracts/mira";
import { describeSchedule } from "@homelab/contracts/operations";
import {
    ActionGroup,
    Badge,
    Button,
    Card,
    ConfirmDialog,
    DropdownMenu,
    ErrorNotice,
    formatDateTime,
    LoadingState,
    PageHeader,
    SectionHeader,
} from "@homelab/ui";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Clock, Pause, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import { api } from "../api/client";
import { AutomationEditor } from "../features/mira/AutomationEditor";
import { MiraDisableDialog } from "../features/mira/MiraDisableDialog";
import { MiraRunHistory } from "../features/mira/MiraRunHistory";
import { useOperation } from "../features/operations/useOperation";

/**
 * Manage Mira's schedules, deliberate pauses and one-off runs in the shared dashboard.
 * @returns Editable automation cards, global pause and durable execution history.
 */
export function MiraAutomations() {
    const navigate = useNavigate();
    const [editing, setEditing] = useState<MiraAutomation | "new">();
    const [paused, setPaused] = useState<{ control: MiraSwitch; title: string }>();
    const [deleting, setDeleting] = useState<MiraAutomation>();
    const query = useInfiniteQuery({
        queryKey: ["operations", "mira", "automations"],
        initialPageParam: undefined as string | undefined,
        queryFn: ({ pageParam }) =>
            api.mira.automations.list.query({
                search: "",
                archived: false,
                ...(pageParam ? { before: pageParam } : {}),
            }),
        getNextPageParam: (page) => page.nextCursor ?? undefined,
        refetchInterval: 15_000,
    });
    const controls = useQuery({
        queryKey: ["operations", "mira", "controls"],
        queryFn: () => api.mira.controls.list.query(),
        refetchInterval: 15_000,
    });
    const enable = useOperation((control: MiraSwitch) =>
        api.mira.controls.setEnabled.mutate({
            key: control.key,
            version: control.version,
            enabled: true,
            reason: null,
            until: null,
        })
    );
    const presets = useOperation(() => api.mira.automations.presets.mutate());
    const run = useOperation((input: { id: string; requestId: string }) =>
        api.mira.automations.run.mutate(input)
    );
    const remove = useOperation((automation: MiraAutomation) =>
        api.mira.automations.delete.mutate({
            id: automation.id,
            version: automation.version,
        })
    );
    const rows = query.data?.pages.flatMap((page) => page.rows) ?? [];
    const global = controls.data?.find((control) => control.key === "autonomy");
    const error =
        query.error ?? controls.error ?? enable.error ?? presets.error ?? run.error;
    return (
        <div className="space-y-4">
            <PageHeader
                title="Automations"
                description="Schedule work, manage heartbeat and pause automatic activity with a reason."
                actions={
                    <Button onClick={() => setEditing("new")}>
                        <Plus size={16} aria-hidden="true" />
                        New automation
                    </Button>
                }
            />
            <Card className="space-y-4">
                <SectionHeader
                    title="Automatic work"
                    icon={Clock}
                    badge={<Badge>{global?.enabled ? "Enabled" : "Paused"}</Badge>}
                    actions={
                        global && (
                            <Button
                                variant="secondary"
                                className="w-full min-[30rem]:w-auto"
                                busy={
                                    enable.isPending &&
                                    enable.variables?.key === "autonomy"
                                }
                                onClick={() =>
                                    global.enabled
                                        ? setPaused({
                                              control: global,
                                              title: "automatic work",
                                          })
                                        : enable.mutate(global)
                                }
                            >
                                {global.enabled
                                    ? "Pause automatic work"
                                    : "Resume automatic work"}
                            </Button>
                        )
                    }
                />
                {global && !global.enabled && (
                    <p className="text-sm text-primary-300">
                        {global.reason}
                        {global.until ? ` · Resumes ${formatDateTime(global.until)}` : ""}
                    </p>
                )}
                {error && <ErrorNotice error={error} />}
            </Card>
            {query.isPending && (
                <Card>
                    <LoadingState label="Loading automations…" />
                </Card>
            )}
            {!query.isPending && rows.length === 0 && (
                <Card className="space-y-4">
                    <p className="text-sm text-primary-300">
                        Restore the morning brief, evening summary, dashboard improvement
                        and heartbeat definitions. They start paused so you can review
                        them.
                    </p>
                    <ActionGroup>
                        <Button
                            busy={presets.isPending}
                            onClick={() => presets.mutate(undefined)}
                        >
                            Add Mira schedules
                        </Button>
                    </ActionGroup>
                </Card>
            )}
            <div className="grid gap-4 xl:grid-cols-2">
                {rows.map((automation) => {
                    const control = controls.data?.find(
                        (item) => item.key === `automation:${automation.id}`
                    );
                    let cadence: string;
                    if (automation.schedule.kind === "once")
                        cadence = `Once · ${formatDateTime(automation.schedule.at)}`;
                    else if (automation.schedule.kind === "event")
                        cadence = `Event · ${automation.schedule.event.replaceAll("_", " ")}`;
                    else cadence = describeSchedule(automation.schedule);
                    return (
                        <Card key={automation.id} className="space-y-4">
                            <SectionHeader
                                title={automation.title}
                                icon={Clock}
                                compactActions
                                actions={
                                    <DropdownMenu
                                        label={`Actions for ${automation.title}`}
                                        actions={[
                                            {
                                                id: "edit",
                                                label: "Edit",
                                                icon: Pencil,
                                                onSelect: () => setEditing(automation),
                                            },
                                            ...(control
                                                ? [
                                                      {
                                                          id: "enabled",
                                                          label: control.enabled
                                                              ? "Pause"
                                                              : "Enable",
                                                          icon: control.enabled
                                                              ? Pause
                                                              : Play,
                                                          disabled: enable.isPending,
                                                          onSelect: () =>
                                                              control.enabled
                                                                  ? setPaused({
                                                                        control,
                                                                        title: automation.title,
                                                                    })
                                                                  : enable.mutate(
                                                                        control
                                                                    ),
                                                      },
                                                  ]
                                                : []),
                                            {
                                                id: "delete",
                                                label: "Delete",
                                                icon: Trash2,
                                                danger: true,
                                                onSelect: () => setDeleting(automation),
                                            },
                                        ]}
                                    />
                                }
                                badge={
                                    <Badge>
                                        {control?.enabled ? "Enabled" : "Paused"}
                                    </Badge>
                                }
                            />
                            <p className="line-clamp-3 text-sm leading-6 text-primary-300">
                                {automation.prompt}
                            </p>
                            <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm [&_dt]:text-primary-400">
                                <dt>Schedule</dt>
                                <dd>{cadence}</dd>
                                <dt>Next run</dt>
                                <dd>
                                    {control?.enabled &&
                                    global?.enabled &&
                                    automation.nextRunAt
                                        ? formatDateTime(automation.nextRunAt)
                                        : "Not scheduled"}
                                </dd>
                                <dt>Run limit</dt>
                                <dd>{automation.budgetSeconds / 60} minutes</dd>
                            </dl>
                            {control && !control.enabled && (
                                <p className="rounded-lg border border-primary-700 bg-primary-950/40 p-3 text-sm text-primary-300">
                                    {control.reason}
                                    {control.until
                                        ? ` · Resumes ${formatDateTime(control.until)}`
                                        : ""}
                                </p>
                            )}
                            <Button
                                fullWidth
                                busy={
                                    run.isPending && run.variables?.id === automation.id
                                }
                                onClick={() =>
                                    void run
                                        .mutateAsync({
                                            id: automation.id,
                                            requestId: crypto.randomUUID(),
                                        })
                                        .then((result) =>
                                            navigate({
                                                to: "/mira/$conversationId",
                                                params: {
                                                    conversationId: result.conversationId,
                                                },
                                            })
                                        )
                                        .catch(() => {})
                                }
                            >
                                <Play size={16} aria-hidden="true" />
                                Run now
                            </Button>
                        </Card>
                    );
                })}
            </div>
            {query.hasNextPage && (
                <Button
                    fullWidth
                    variant="secondary"
                    busy={query.isFetchingNextPage}
                    onClick={() => void query.fetchNextPage()}
                >
                    Load more automations
                </Button>
            )}
            <MiraRunHistory />
            {editing && (
                <AutomationEditor
                    automation={editing === "new" ? undefined : editing}
                    onClose={() => setEditing(undefined)}
                />
            )}
            {paused && (
                <MiraDisableDialog {...paused} onClose={() => setPaused(undefined)} />
            )}
            {deleting && (
                <ConfirmDialog
                    title="Delete automation"
                    description="Stop future and queued runs. A running invocation can be stopped separately."
                    confirmLabel="Delete automation"
                    onClose={() => setDeleting(undefined)}
                    onConfirm={async () => {
                        await remove.mutateAsync(deleting);
                        setDeleting(undefined);
                    }}
                />
            )}
        </div>
    );
}
