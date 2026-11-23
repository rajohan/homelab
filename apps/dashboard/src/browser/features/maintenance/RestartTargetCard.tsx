import { Badge, Button } from "@homelab/ui";

import { type RestartPlan, restartRequirement } from "./restartNavigation";

/**
 * Show one restart target with the shared responsive actions and confirmation entry point.
 * @returns Current requirement, service impact and permitted controls.
 */
export function RestartTargetCard({
    plan,
    refreshing,
    stale,
    onRefresh,
    onRestart,
}: {
    readonly plan: RestartPlan;
    readonly refreshing: boolean;
    readonly stale: boolean;
    readonly onRefresh: (plan: RestartPlan) => void;
    readonly onRestart: (plan: RestartPlan) => void;
}) {
    const required = restartRequirement(plan);
    const evidence = plan.serviceEvidence;
    let requirement = "Not reported";
    if (!plan.observed) requirement = "Awaiting fresh status";
    if (evidence === "check-failed") requirement = "Check failed";
    if (plan.active === "inactive") requirement = "Service stopped";
    if (required !== null)
        requirement = required ? "Restart required" : "No restart required";
    const hints = {
        "not-installed": "This host needs the needrestart package to check services.",
        "check-failed": "The host could not complete its service restart check.",
        stopped: undefined,
        measured: undefined,
    };
    const hint = evidence ? hints[evidence] : undefined;
    return (
        <div className="@container/restart rounded-lg border border-primary-700 bg-surface-card p-4">
            <div className="grid gap-3 @min-[40rem]/restart:grid-cols-[minmax(0,1fr)_auto]">
                <div className="flex flex-wrap items-center gap-2">
                    <h4 className="font-medium">{plan.label}</h4>
                    <Badge
                        title={hint}
                        className="self-center"
                        tone={required ? "warning" : "neutral"}
                    >
                        {requirement}
                    </Badge>
                    {plan.proxmox && <Badge tone="info">Via Proxmox</Badge>}
                    {plan.external && (
                        <Badge className="self-center">External restart</Badge>
                    )}
                </div>
                <div className="col-span-full space-y-3">
                    <p className="text-sm text-primary-300">{plan.impact}</p>
                    {hint && <p className="text-xs text-primary-400">{hint}</p>}
                    {plan.reason && plan.reason !== plan.impact && (
                        <p className="text-sm text-primary-400">{plan.reason}</p>
                    )}
                </div>
                <div className="flex flex-col gap-2 @min-[40rem]/restart:col-start-2 @min-[40rem]/restart:row-start-1 @min-[40rem]/restart:flex-row @min-[40rem]/restart:self-start">
                    <Button
                        className="w-full @min-[40rem]/restart:w-auto"
                        variant="secondary"
                        disabled={refreshing}
                        onClick={() => onRefresh(plan)}
                    >
                        Refresh status
                    </Button>
                    {!plan.external && (
                        <Button
                            className="w-full @min-[40rem]/restart:w-auto"
                            variant="secondary"
                            disabled={!plan.allowed || stale}
                            onClick={() => onRestart(plan)}
                        >
                            Restart
                        </Button>
                    )}
                </div>
            </div>
        </div>
    );
}
