import type { UpdateItem } from "@homelab/contracts/updates";
import { Badge } from "@homelab/ui";

/**
 * Render update availability independently of installation permission or pin policy.
 * @returns Security, held, available, current or unknown status.
 */
export function UpdateStatus({
    item,
    stale,
}: {
    readonly item: UpdateItem;
    readonly stale: boolean;
}) {
    if (stale) return <Badge tone="warning">Stale check</Badge>;
    if (item.held)
        return (
            <Badge tone={item.status === "available" ? "warning" : "neutral"}>
                {item.status === "available" ? "Held update" : "Held"}
            </Badge>
        );
    if (item.status === "available")
        return (
            <Badge tone={item.security ? "danger" : "warning"}>
                {item.security ? "Security update" : "Update available"}
            </Badge>
        );
    return (
        <Badge tone={item.status === "current" ? "positive" : "neutral"}>
            {item.status === "current" ? "Current" : "Not checked"}
        </Badge>
    );
}
