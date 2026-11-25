import {
    Button,
    EmptyState,
    ErrorNotice,
    LoadingState,
    queryRefresh,
    SearchInput,
    SectionPanel,
    Select,
    SummaryStrip,
    VirtualList,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { useJobOperation } from "../jobs/useJobOperation";
import { RestartBatchDialog } from "./RestartBatchDialog";
import { RestartBatchProgress } from "./RestartBatchProgress";
import { RestartDialog } from "./RestartDialog";
import { RestartHostGroup } from "./RestartHostGroup";
import {
    type RequirementFilter,
    restartGroups,
    type RestartLocationFilter,
    type RestartPlan,
    restartWorkload,
} from "./restartNavigation";
import { restartPlansQuery } from "./restartPlansQuery";

const controllerLabels = {
    waiting: "Waiting for active work to finish",
    submitted: "Proxmox is verifying the restart",
    verified: "Recovery verified by Proxmox",
    refused: "Restart was not started",
    unverified: "Recovery could not be verified. Inspect the guest before retrying.",
};

/** Review pending service and host restarts across the fleet.
 * @returns Per-host requirements, inspection controls and individually confirmed or grouped service restarts.
 */
export function MaintenancePanel() {
    const query = useQuery(restartPlansQuery);
    const controller = useQuery({
        queryKey: ["operations", "proxmox-restart"],
        queryFn: ({ signal }) =>
            api.maintenance.controllerStatus.query(undefined, { signal }),
        ...queryRefresh("fast"),
        retry: false,
    });
    const batch = useQuery({
        queryKey: ["operations", "restart-batch"],
        queryFn: ({ signal }) => api.maintenance.batchStatus.query(undefined, { signal }),
        ...queryRefresh("fast"),
        retry: false,
    });
    const [selected, setSelected] = useState<RestartPlan>();
    const [bulk, setBulk] = useState<ReturnType<typeof restartWorkload>>();
    const [search, setSearch] = useState("");
    const [requirement, setRequirement] = useState<RequirementFilter>("attention");
    const [location, setLocation] = useState<RestartLocationFilter>("all");
    const plans = query.data ?? [];
    const workload = restartWorkload(plans);
    const groups = restartGroups(plans, search, requirement, location);
    const busy = batch.data?.phase === "running" || batch.data?.phase === "waiting";
    const refresh = useJobOperation(
        (input: { action: string; requestId: string }, signal) =>
            api.jobs.run.mutate(input, { signal })
    );
    const clear =
        !query.isError &&
        plans.length > 0 &&
        !search.trim() &&
        location === "all" &&
        requirement === "attention";
    return (
        <SectionPanel
            className="@container/restarts"
            title="Restarts"
            icon={RotateCw}
            compactActions={false}
            actions={
                workload.eligible.length > 0 && (
                    <Button
                        variant="secondary"
                        disabled={
                            query.isError || busy || batch.isPending || batch.isError
                        }
                        onClick={() => setBulk(workload)}
                    >
                        <RotateCw className="size-4" aria-hidden="true" />
                        Restart all services
                    </Button>
                )
            }
        >
            {query.isPending && <LoadingState label="Loading restart status…" />}
            {query.isError && <ErrorNotice error={query.error} />}
            {refresh.isError && <ErrorNotice error={refresh.error} />}
            {plans.length > 0 && (
                <>
                    <SummaryStrip
                        label="Required restarts"
                        items={[
                            {
                                label:
                                    workload.eligible.length === 1
                                        ? "Service restart in dashboard"
                                        : "Service restarts in dashboard",
                                value: workload.eligible.length,
                            },
                            {
                                label:
                                    workload.manual.length === 1
                                        ? "Manual service restart"
                                        : "Manual service restarts",
                                value: workload.manual.length,
                                attention: workload.manual.length > 0,
                            },
                            {
                                label:
                                    workload.reboots.length === 1
                                        ? "Host reboot"
                                        : "Host reboots",
                                value: workload.reboots.length,
                                attention: workload.reboots.length > 0,
                            },
                            {
                                label:
                                    workload.incompleteHosts === 1
                                        ? "Host with incomplete checks"
                                        : "Hosts with incomplete checks",
                                value: workload.incompleteHosts,
                                attention: workload.incompleteHosts > 0,
                            },
                            ...(workload.unavailable.length > 0
                                ? [
                                      {
                                          label:
                                              workload.unavailable.length === 1
                                                  ? "Unavailable service restart"
                                                  : "Unavailable service restarts",
                                          value: workload.unavailable.length,
                                          attention: true,
                                      },
                                  ]
                                : []),
                        ]}
                    />
                    <div className="grid gap-3 @min-[21rem]/restarts:grid-cols-[minmax(0,1.12fr)_minmax(0,0.88fr)] @min-[52rem]/restarts:grid-cols-[minmax(0,1fr)_12rem_12rem]">
                        <SearchInput
                            className="@min-[21rem]/restarts:col-span-2 @min-[52rem]/restarts:col-span-1"
                            label="Search restart targets"
                            placeholder="Search hosts or services…"
                            value={search}
                            maxLength={160}
                            onChange={setSearch}
                        />
                        <Select<RequirementFilter>
                            label="Restart requirement"
                            value={requirement}
                            onChange={setRequirement}
                            options={[
                                { value: "attention", label: "Needs attention" },
                                { value: "all", label: "All statuses" },
                                { value: "required", label: "Required" },
                                { value: "unknown", label: "Incomplete" },
                                { value: "not-required", label: "Not required" },
                            ]}
                        />
                        <Select<RestartLocationFilter>
                            label="Restart location"
                            value={location}
                            onChange={setLocation}
                            options={[
                                { value: "all", label: "All locations" },
                                { value: "dashboard", label: "Dashboard" },
                                { value: "external", label: "Manual only" },
                            ]}
                        />
                    </div>
                </>
            )}
            {batch.isError && <ErrorNotice error={batch.error} />}
            {batch.data && <RestartBatchProgress batch={batch.data} />}
            {controller.isError && <ErrorNotice error={controller.error} />}
            {controller.data && (
                <output className="rounded-lg border border-primary-700 bg-surface-card p-3 text-sm">
                    <strong>{controller.data.label}</strong> ·{" "}
                    {controllerLabels[controller.data.phase]}
                </output>
            )}
            {query.data && !query.isError && plans.length === 0 && (
                <EmptyState message="No hosts are configured for restart monitoring." />
            )}
            {plans.length > 0 && groups.length === 0 && (
                <EmptyState
                    message={
                        clear
                            ? "No host or service restarts are required."
                            : "No targets match these filters."
                    }
                />
            )}
            {groups.length > 0 && (
                <VirtualList
                    key={JSON.stringify([
                        search.trim().toLowerCase(),
                        requirement,
                        location,
                    ])}
                    label="Restart targets"
                    rows={groups}
                    getKey={(group) => group.host.id}
                    scrollbarGap
                    renderItem={(group) => (
                        <RestartHostGroup
                            group={group}
                            refreshing={refresh.isPending}
                            stale={query.isError}
                            onRefresh={(plan) =>
                                void refresh
                                    .mutateAsync({
                                        action: `maintenance.inspect.${plan.inspectTarget}`,
                                        requestId: crypto.randomUUID(),
                                    })
                                    .catch(() => {})
                            }
                            onRestart={setSelected}
                        />
                    )}
                />
            )}
            {selected && (
                <RestartDialog plan={selected} onClose={() => setSelected(undefined)} />
            )}
            {bulk && (
                <RestartBatchDialog workload={bulk} onClose={() => setBulk(undefined)} />
            )}
        </SectionPanel>
    );
}
