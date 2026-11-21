import type { MiraAutomation, MiraSwitch } from "@homelab/contracts/mira";
import { describeSchedule } from "@homelab/contracts/operations";
import {
    Badge,
    Button,
    CatalogRow,
    ConfirmDialog,
    DetailFacts,
    DropdownMenu,
    ErrorNotice,
    formatDateTime,
    InfiniteScrollTrigger,
    LoadingState,
    PageHeader,
    PageSections,
    SectionPanel,
} from "@homelab/ui";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
    CalendarClock,
    Clock,
    Code2,
    Pause,
    Pencil,
    Play,
    Plus,
    Trash2,
} from "lucide-react";
import { useState } from "react";

import { api } from "../api/client";
import { AutomationEditor } from "../features/mira/AutomationEditor";
import { ImprovementPermission } from "../features/mira/ImprovementPermission";
import { MiraBrowserControl } from "../features/mira/MiraBrowserControl";
import { MiraDisableDialog } from "../features/mira/MiraDisableDialog";
import { MiraIntegrations } from "../features/mira/MiraIntegrations";
import { MiraRunHistory } from "../features/mira/MiraRunHistory";
import { MiraSkills } from "../features/mira/MiraSkills";
import { RunAutomationButton } from "../features/mira/RunAutomationButton";
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
    const [coding, setCoding] = useState<MiraAutomation>();
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
    const remove = useOperation((automation: MiraAutomation) =>
        api.mira.automations.delete.mutate({
            id: automation.id,
            version: automation.version,
        })
    );
    const rows = query.data?.pages.flatMap((page) => page.rows) ?? [];
    const global = controls.data?.find((control) => control.key === "autonomy");
    const error = query.error ?? controls.error ?? enable.error ?? presets.error;
    return (
        <div className="@container/automations space-y-4">
            <PageHeader
                icon={Clock}
                title="Automations"
                accessory={
                    global &&
                    !global.enabled && <Badge tone="neutral">Automatic work paused</Badge>
                }
                description={
                    global && !global.enabled
                        ? [
                              global.reason,
                              global.until && `Resumes ${formatDateTime(global.until)}`,
                          ]
                              .filter(Boolean)
                              .join(" · ")
                        : undefined
                }
                actions={
                    global && (
                        <Button
                            variant="secondary"
                            busy={
                                enable.isPending && enable.variables?.key === "autonomy"
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
                            {global.enabled ? (
                                <Pause size={15} aria-hidden="true" />
                            ) : (
                                <Play size={15} aria-hidden="true" />
                            )}
                            {global.enabled
                                ? "Pause automatic work"
                                : "Resume automatic work"}
                        </Button>
                    )
                }
            />
            {error && <ErrorNotice error={error} />}
            <PageSections
                deferBelowFold
                label="Automation sections"
                sections={[
                    {
                        id: "schedules",
                        width: rows.length === 0 ? "half" : "full",
                        label: "Schedules",
                        content: (
                            <SectionPanel
                                title="Schedules"
                                icon={CalendarClock}
                                actions={
                                    <Button onClick={() => setEditing("new")}>
                                        <Plus size={16} aria-hidden="true" />
                                        New automation
                                    </Button>
                                }
                            >
                                {query.isPending && (
                                    <LoadingState label="Loading automations…" />
                                )}
                                {query.isSuccess && rows.length === 0 && (
                                    <div className="flex flex-wrap items-center justify-between gap-4 py-1">
                                        <div className="max-w-xl min-w-0">
                                            <h3 className="text-base font-semibold">
                                                No schedules yet
                                            </h3>
                                            <p className="mt-1 text-sm leading-relaxed text-primary-400">
                                                Start with a morning brief, evening
                                                summary, dashboard improvement and
                                                heartbeat. All four start paused.
                                            </p>
                                        </div>
                                        <Button
                                            variant="secondary"
                                            busy={presets.isPending}
                                            onClick={() => presets.mutate(undefined)}
                                        >
                                            Add Mira schedules
                                        </Button>
                                    </div>
                                )}
                                {rows.length > 0 && (
                                    <ul className="divide-y divide-primary-700/70">
                                        {rows.map((automation) => {
                                            const control = controls.data?.find(
                                                (item) =>
                                                    item.key ===
                                                    `automation:${automation.id}`
                                            );
                                            let cadence: string;
                                            if (automation.schedule.kind === "once")
                                                cadence = `Once · ${formatDateTime(automation.schedule.at)}`;
                                            else if (automation.schedule.kind === "event")
                                                cadence = `Event · ${automation.schedule.event.replaceAll("_", " ")}`;
                                            else
                                                cadence = describeSchedule(
                                                    automation.schedule
                                                );
                                            return (
                                                <CatalogRow
                                                    key={automation.id}
                                                    icon={Clock}
                                                    title={automation.title}
                                                    status={
                                                        control && (
                                                            <Badge
                                                                tone={
                                                                    control.enabled
                                                                        ? "positive"
                                                                        : "neutral"
                                                                }
                                                            >
                                                                {control.enabled
                                                                    ? "Enabled"
                                                                    : "Paused"}
                                                            </Badge>
                                                        )
                                                    }
                                                    description={
                                                        <span className="line-clamp-3">
                                                            {automation.prompt}
                                                        </span>
                                                    }
                                                    actions={
                                                        <>
                                                            <RunAutomationButton
                                                                id={automation.id}
                                                                onStarted={(
                                                                    conversationId
                                                                ) =>
                                                                    void navigate({
                                                                        to: "/mira/$conversationId",
                                                                        params: {
                                                                            conversationId,
                                                                        },
                                                                    })
                                                                }
                                                            />
                                                            <DropdownMenu
                                                                label={`Actions for ${automation.title}`}
                                                                actions={[
                                                                    {
                                                                        id: "edit",
                                                                        label: "Edit",
                                                                        icon: Pencil,
                                                                        onSelect: () =>
                                                                            setEditing(
                                                                                automation
                                                                            ),
                                                                    },
                                                                    ...(automation.kind ===
                                                                    "improvement"
                                                                        ? [
                                                                              {
                                                                                  id: "coding",
                                                                                  label: "Code permissions",
                                                                                  icon: Code2,
                                                                                  onSelect:
                                                                                      () =>
                                                                                          setCoding(
                                                                                              automation
                                                                                          ),
                                                                              },
                                                                          ]
                                                                        : []),
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
                                                                                  disabled:
                                                                                      enable.isPending,
                                                                                  onSelect:
                                                                                      () =>
                                                                                          control.enabled
                                                                                              ? setPaused(
                                                                                                    {
                                                                                                        control,
                                                                                                        title: automation.title,
                                                                                                    }
                                                                                                )
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
                                                                        onSelect: () =>
                                                                            setDeleting(
                                                                                automation
                                                                            ),
                                                                    },
                                                                ]}
                                                            />
                                                        </>
                                                    }
                                                >
                                                    <DetailFacts
                                                        inline
                                                        items={[
                                                            {
                                                                label: "Schedule",
                                                                value: cadence,
                                                            },
                                                            {
                                                                label: "Next run",
                                                                value:
                                                                    control?.enabled &&
                                                                    global?.enabled &&
                                                                    automation.nextRunAt
                                                                        ? formatDateTime(
                                                                              automation.nextRunAt
                                                                          )
                                                                        : "Not scheduled",
                                                            },
                                                            {
                                                                label: "Run limit",
                                                                value: `${automation.budgetSeconds / 60} min`,
                                                            },
                                                        ]}
                                                    />
                                                    {control && !control.enabled && (
                                                        <p className="text-xs text-primary-400">
                                                            {[
                                                                control.reason,
                                                                control.until &&
                                                                    `Resumes ${formatDateTime(control.until)}`,
                                                            ]
                                                                .filter(Boolean)
                                                                .join(" · ")}
                                                        </p>
                                                    )}
                                                </CatalogRow>
                                            );
                                        })}
                                    </ul>
                                )}
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
                            </SectionPanel>
                        ),
                    },
                    {
                        id: "automation-history",
                        width: rows.length === 0 ? "half" : "full",
                        label: "Run history",
                        content: <MiraRunHistory title="Run history" />,
                    },
                    {
                        id: "integrations",
                        label: "Integrations",
                        content: <MiraIntegrations />,
                    },
                    { id: "browser", label: "Browser", content: <MiraBrowserControl /> },
                    { id: "skills", label: "Skills", content: <MiraSkills /> },
                ]}
            />
            {editing && (
                <AutomationEditor
                    agentMailAvailable
                    automation={editing === "new" ? undefined : editing}
                    onClose={() => setEditing(undefined)}
                />
            )}
            {paused && (
                <MiraDisableDialog {...paused} onClose={() => setPaused(undefined)} />
            )}
            {coding && (
                <ImprovementPermission
                    automation={coding}
                    onClose={() => setCoding(undefined)}
                />
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
