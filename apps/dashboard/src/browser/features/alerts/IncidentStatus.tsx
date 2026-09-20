import type { Incident } from "@homelab/contracts/alerts";
import { Badge } from "@homelab/ui";

const active = {
    error: { tone: "danger", label: "Critical" },
    warning: { tone: "warning", label: "Warning" },
    info: { tone: "neutral", label: "Active" },
} as const;

/**
 * Keep incident state separate from the operator's personal notification read state.
 * @returns Severity-colored active incidents, muted suppression or confirmed resolution.
 */
export function IncidentStatus({
    incident,
    unavailable,
}: {
    readonly incident: Incident;
    readonly unavailable: boolean;
}) {
    if (incident.state === "resolved") return <Badge tone="positive">Resolved</Badge>;
    if (unavailable) return <Badge tone="warning">Unknown</Badge>;
    if (incident.state === "suppressed") return <Badge tone="neutral">Suppressed</Badge>;
    const display = active[incident.severity];
    return <Badge tone={display.tone}>{display.label}</Badge>;
}
