import {
    Badge,
    Button,
    Card,
    ErrorNotice,
    LoadingState,
    SectionHeader,
    queryRefresh,
    formatDateTime,
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
                    No restart targets are configured. Targets must be reviewed
                    separately; the worker, its database and the hosts they depend on need
                    external maintenance.
                </p>
            )}
            {query.data && query.data.length > 0 && (
                <div className="space-y-3">
                    {query.data.map((plan) => (
                        <div
                            key={plan.target}
                            className="space-y-3 rounded-lg border border-primary-700 bg-primary-950/40 p-4"
                        >
                            <div className="flex flex-wrap items-center gap-2">
                                <h3 className="font-medium">{plan.label}</h3>
                                <Badge
                                    tone={
                                        plan.required && plan.allowed
                                            ? "warning"
                                            : "neutral"
                                    }
                                >
                                    {requirementLabel(plan.allowed, plan.required)}
                                </Badge>
                            </div>
                            <p className="text-sm text-primary-300">{plan.impact}</p>
                            {plan.capturedAt && (
                                <p className="text-xs text-primary-400">
                                    Checked {formatDateTime(plan.capturedAt)}
                                </p>
                            )}
                            {plan.reason && (
                                <p className="text-sm text-primary-400">{plan.reason}</p>
                            )}
                            <div className="flex flex-wrap gap-2">
                                <Button
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
                                <Button
                                    variant="secondary"
                                    disabled={!plan.allowed || query.isError}
                                    onClick={() => setSelected(plan)}
                                >
                                    Restart…
                                </Button>
                            </div>
                        </div>
                    ))}
                </div>
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
