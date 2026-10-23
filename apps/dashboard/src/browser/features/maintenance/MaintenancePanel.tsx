import {
    Badge,
    Button,
    Card,
    ErrorNotice,
    LoadingState,
    SectionHeader,
    VirtualList,
    queryRefresh,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { RotateCw } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { useJobOperation } from "../jobs/useJobOperation";
import { RestartDialog } from "./RestartDialog";

/**
 * Show deployment-approved restart targets and current requirements independently of software updates.
 * @returns Shared controls for read-only refresh and human-confirmed restart jobs.
 */
export function MaintenancePanel() {
    const query = useQuery({
        queryKey: ["operations", "maintenance"],
        queryFn: ({ signal }) => api.maintenance.plans.query(undefined, { signal }),
        ...queryRefresh("fast"),
        retry: false,
    });
    const [selected, setSelected] = useState<NonNullable<typeof query.data>[number]>();
    const refresh = useJobOperation(
        (input: { action: string; requestId: string }, signal) =>
            api.jobs.run.mutate(input, { signal })
    );
    return (
        <Card className="space-y-4">
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
                <VirtualList
                    label="Restart targets"
                    rows={query.data}
                    getKey={(plan) => plan.target}
                    scrollbarGap
                    renderItem={(plan) => (
                        <div className="@container/restart rounded-lg border border-primary-700 bg-primary-950/40 p-4">
                            <div className="grid gap-3 @min-[40rem]/restart:grid-cols-[minmax(0,1fr)_auto]">
                                <div className="flex flex-wrap items-center gap-2">
                                    <h3 className="font-medium">{plan.label}</h3>
                                    <Badge
                                        className="self-center"
                                        tone={
                                            plan.required &&
                                            (plan.allowed || plan.external)
                                                ? "warning"
                                                : "neutral"
                                        }
                                    >
                                        {requirementLabel(
                                            plan.allowed || plan.external,
                                            plan.required
                                        )}
                                    </Badge>
                                    {plan.external && (
                                        <Badge className="self-center">
                                            External restart
                                        </Badge>
                                    )}
                                </div>
                                <div className="col-span-full space-y-3">
                                    <p className="text-sm text-primary-300">
                                        {plan.impact}
                                    </p>
                                    {plan.reason && plan.reason !== plan.impact && (
                                        <p className="text-sm text-primary-400">
                                            {plan.reason}
                                        </p>
                                    )}
                                </div>
                                <div className="flex flex-col gap-2 @min-[40rem]/restart:col-start-2 @min-[40rem]/restart:row-start-1 @min-[40rem]/restart:flex-row @min-[40rem]/restart:self-start">
                                    <Button
                                        className="w-full @min-[40rem]/restart:w-auto"
                                        variant="secondary"
                                        disabled={refresh.isPending}
                                        onClick={() =>
                                            void refresh
                                                .mutateAsync({
                                                    action: `maintenance.inspect.${plan.target}`,
                                                    requestId: crypto.randomUUID(),
                                                })
                                                .catch(() => {})
                                        }
                                    >
                                        Refresh status
                                    </Button>
                                    {!plan.external && (
                                        <Button
                                            className="w-full @min-[40rem]/restart:w-auto"
                                            variant="secondary"
                                            disabled={!plan.allowed || query.isError}
                                            onClick={() => setSelected(plan)}
                                        >
                                            Restart
                                        </Button>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}
                />
            )}
            {selected && (
                <RestartDialog plan={selected} onClose={() => setSelected(undefined)} />
            )}
        </Card>
    );
}

function requirementLabel(allowed: boolean, required: boolean | null): string {
    if (!allowed || required === null) return "Requirement unknown";
    return required ? "Restart required" : "No restart required";
}
