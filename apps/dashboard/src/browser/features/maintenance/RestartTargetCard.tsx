import { Badge, Button, CatalogRow } from "@homelab/ui";
import { Cog, Server } from "lucide-react";

import type { RestartPlan } from "./restartNavigation";

function statusLabel(plan: RestartPlan): string {
    if (plan.required === true)
        return plan.kind === "host" ? "Reboot required" : "Restart required";
    if (plan.required === false)
        return plan.kind === "host" ? "No reboot required" : "Up to date";
    return plan.active === "inactive" ? "Service stopped" : "No current reading";
}

/** Show a single service or host reboot with its current reading, impact and permitted actions.
 * @param props - Current plan, request availability and callbacks for refresh or confirmation.
 * @returns A responsive directory row for one target.
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
    const host = plan.kind === "host";
    const evidence = host ? plan.fleetEvidence : plan.serviceEvidence;
    let hint: string | undefined;
    if (evidence === "not-installed")
        hint = "Install needrestart on this host to report pending services.";
    else if (evidence === "check-failed")
        hint = "The service restart check failed. Refresh the status to check again.";
    else if (host && !evidence)
        hint = "Service restart coverage is awaiting a fresh host check.";
    return (
        <CatalogRow
            title={host ? "Host reboot" : plan.label}
            icon={host ? Server : Cog}
            meta={
                plan.unit && plan.unit !== plan.label ? (
                    <span className="wrap-anywhere">{plan.unit}</span>
                ) : undefined
            }
            status={
                <>
                    <Badge tone={plan.required ? "warning" : "neutral"}>
                        {statusLabel(plan)}
                    </Badge>
                    {plan.external ? (
                        <Badge tone={plan.required ? "warning" : "neutral"}>
                            Manual only
                        </Badge>
                    ) : (
                        plan.proxmox && <Badge tone="info">Via Proxmox</Badge>
                    )}
                </>
            }
            description={plan.impact}
            actions={
                <>
                    <Button
                        variant="secondary"
                        size="sm"
                        disabled={refreshing}
                        onClick={() => onRefresh(plan)}
                    >
                        Refresh
                    </Button>
                    {!plan.external && (
                        <Button
                            size="sm"
                            variant="secondary"
                            disabled={!plan.allowed || stale}
                            aria-label={
                                host
                                    ? `Reboot ${plan.host.label}`
                                    : `Restart ${plan.label} on ${plan.host.label}`
                            }
                            onClick={() => onRestart(plan)}
                        >
                            {host ? "Reboot host" : "Restart"}
                        </Button>
                    )}
                </>
            }
        >
            {hint && <p className="text-amber-300">{hint}</p>}
            {plan.reason && plan.reason !== plan.impact && (
                <p className="text-primary-400">{plan.reason}</p>
            )}
        </CatalogRow>
    );
}
