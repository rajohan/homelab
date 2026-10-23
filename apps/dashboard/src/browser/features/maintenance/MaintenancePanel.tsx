import {
    Card,
    ErrorNotice,
    LoadingState,
    SearchInput,
    SectionHeader,
    Select,
    VirtualList,
    queryRefresh,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { useJobOperation } from "../jobs/useJobOperation";
import { RestartDialog } from "./RestartDialog";
import { RestartHostGroup } from "./RestartHostGroup";
import {
    restartGroups,
    type RequirementFilter,
    type RestartLocationFilter,
    type RestartPlan,
} from "./restartNavigation";

/**
 * Show deployment-approved restart targets with host navigation and current requirements.
 * @returns Searchable host groups and shared controls for human-confirmed restarts.
 */
export function MaintenancePanel() {
    const query = useQuery({
        queryKey: ["operations", "maintenance"],
        queryFn: ({ signal }) => api.maintenance.plans.query(undefined, { signal }),
        ...queryRefresh("fast"),
        retry: false,
    });
    const [selected, setSelected] = useState<RestartPlan>();
    const [search, setSearch] = useState("");
    const [requirement, setRequirement] = useState<RequirementFilter>("all");
    const [location, setLocation] = useState<RestartLocationFilter>("all");
    const groups = restartGroups(query.data ?? [], search, requirement, location);
    const count = groups.reduce((total, group) => total + group.plans.length, 0);
    const refresh = useJobOperation(
        (input: { action: string; requestId: string }, signal) =>
            api.jobs.run.mutate(input, { signal })
    );
    return (
        <Card className="@container/restarts space-y-4">
            <SectionHeader
                title="Restarts"
                description="Review service impact and verify recovery after a confirmed restart."
                icon={RotateCw}
            />
            {query.isPending && <LoadingState label="Loading restart status…" />}
            {query.isError && <ErrorNotice error={query.error} />}
            {refresh.isError && <ErrorNotice error={refresh.error} />}
            {query.data?.length === 0 && (
                <p className="text-sm text-primary-400">
                    No restart targets are configured.
                </p>
            )}
            {query.data && query.data.length > 0 && (
                <>
                    <div className="grid gap-3 @min-[32rem]/restarts:grid-cols-2 @min-[52rem]/restarts:grid-cols-[minmax(0,1fr)_12rem_12rem]">
                        <SearchInput
                            className="@min-[32rem]/restarts:col-span-2 @min-[52rem]/restarts:col-span-1"
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
                                { value: "all", label: "All statuses" },
                                { value: "required", label: "Restart required" },
                                { value: "unknown", label: "Requirement unknown" },
                                { value: "not-required", label: "No restart required" },
                            ]}
                        />
                        <Select<RestartLocationFilter>
                            label="Restart location"
                            value={location}
                            onChange={setLocation}
                            options={[
                                { value: "all", label: "All restart locations" },
                                { value: "dashboard", label: "In dashboard" },
                                { value: "external", label: "External restart" },
                            ]}
                        />
                    </div>
                    <output className="block text-sm text-primary-400">
                        {count} of {query.data.length} targets · {groups.length}{" "}
                        {groups.length === 1 ? "host" : "hosts"}
                    </output>
                    {groups.length === 0 && (
                        <p className="rounded-lg border border-primary-700 bg-primary-950/40 p-4 text-sm text-primary-400">
                            No restart targets match. Change the filters or clear the
                            search.
                        </p>
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
                            itemClassName="pb-5 last:pb-0"
                            renderItem={(group) => (
                                <RestartHostGroup
                                    group={group}
                                    refreshing={refresh.isPending}
                                    stale={query.isError}
                                    onRefresh={(plan) =>
                                        void refresh
                                            .mutateAsync({
                                                action: `maintenance.inspect.${plan.target}`,
                                                requestId: crypto.randomUUID(),
                                            })
                                            .catch(() => {})
                                    }
                                    onRestart={setSelected}
                                />
                            )}
                        />
                    )}
                </>
            )}
            {selected && (
                <RestartDialog plan={selected} onClose={() => setSelected(undefined)} />
            )}
        </Card>
    );
}
