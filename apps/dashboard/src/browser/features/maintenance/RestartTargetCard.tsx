import { Badge, Button, CatalogRow, formatDateTime } from "@homelab/ui";
import { Cog, Server } from "lucide-react";

import {
    incompleteRestart,
    reportedRestart,
    type RestartPlan,
} from "./restartNavigation";

function statusLabel(plan: RestartPlan): string {
    if (plan.required === true)
        return plan.kind === "host" ? "Reboot required" : "Restart required";
    if (plan.kind === "service" && plan.active === "inactive") return "Service stopped";
    if (plan.required === false)
        return plan.kind === "host" ? "No reboot required" : "Up to date";
    if (plan.lastReportedRequired === true)
        return plan.kind === "host"
            ? "Reboot required at last check"
            : "Restart required at last check";
    if (plan.lastReportedRequired === false)
        return plan.kind === "host"
            ? "No reboot required at last check"
            : "Up to date at last check";
    return plan.kind === "host" ? "Reboot status unknown" : "Restart status unknown";
}

function incompleteNote(plan: RestartPlan) {
    if (!incompleteRestart(plan)) return null;
    const host = plan.kind === "host";
    const evidence = host ? plan.fleetEvidence : plan.serviceEvidence;
    if (evidence === "not-installed")
        return `Install needrestart on ${plan.host.label} to report pending services.`;
    if (evidence === "check-failed")
        return "The service restart check failed. Refresh to try again.";
    if (host && evidence === "measured")
        return "The service check completed. The host did not report whether a reboot is required.";
    if (plan.observed && host)
        return "The current host reading does not include a service restart report.";
    if (plan.observed && !evidence && plan.inspectTarget !== plan.target)
        return "Waiting for a current host report to determine whether this service needs a restart.";
    if (!plan.observed && plan.capturedAt && !plan.lastReportedAt)
        return `Waiting for a fresh restart check. Last observation ${formatDateTime(plan.capturedAt)}.`;
    return host
        ? "Waiting for a current host restart check."
        : "Waiting for a current service restart check.";
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
    const previous =
        plan.required === null && typeof plan.lastReportedRequired === "boolean";
    const tone = reportedRestart(plan) ? "warning" : "neutral";
    const hint = incompleteNote(plan);
    const reason = !plan.observed && hint && !plan.external ? null : plan.reason;
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
                    <Badge tone={tone}>{statusLabel(plan)}</Badge>
                    {plan.external ? (
                        <Badge tone={tone}>Manual only</Badge>
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
                            disabled={!plan.allowed || stale || previous}
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
            {hint && (
                <p className="text-amber-300">
                    {hint}
                    {previous &&
                        plan.lastReportedAt &&
                        ` Last measured ${formatDateTime(plan.lastReportedAt)}.`}
                </p>
            )}
            {reason && reason !== plan.impact && (
                <p className="text-primary-400">{reason}</p>
            )}
        </CatalogRow>
    );
}
