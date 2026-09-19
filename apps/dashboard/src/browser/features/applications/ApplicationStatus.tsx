import { Badge } from "@homelab/ui";

/**
 * Distinguish current Docker health from stopped and transitional states.
 * @returns A compact status badge, with neutral rather than healthy for stopped containers.
 */
export function ApplicationStatus({
    state,
    health,
    available = true,
}: {
    readonly state: string;
    readonly health: string | null;
    readonly available?: boolean;
}) {
    if (!available) return <Badge tone="warning">Unknown</Badge>;
    const failed = health === "unhealthy" || state === "dead";
    const active = state === "running" && (!health || health === "healthy");
    const transitional =
        ["restarting", "paused"].includes(state) || health === "starting";
    let tone: "danger" | "positive" | "warning" | "neutral" = "neutral";
    if (failed) tone = "danger";
    else if (active) tone = "positive";
    else if (transitional) tone = "warning";
    const label = state === "running" ? (health ?? state) : state;
    return <Badge tone={tone}>{label.charAt(0).toUpperCase() + label.slice(1)}</Badge>;
}
