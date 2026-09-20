import type { MonitoringRule } from "@homelab/contracts/alerts";
import { Badge } from "@homelab/ui";

/**
 * Prioritize evaluator failures and stale data over the last alert expression result.
 * @returns A semantic status badge, never healthy solely because an old rule was inactive.
 */
export function RuleStatus({
    rule,
    stale,
}: {
    readonly rule: MonitoringRule;
    readonly stale: boolean;
}) {
    if (stale || rule.health === "unknown" || rule.state === "unknown")
        return <Badge tone="warning">Unknown</Badge>;
    if (rule.health === "error") return <Badge tone="danger">Evaluation failed</Badge>;
    if (rule.state === "firing") return <Badge tone="danger">Firing</Badge>;
    if (rule.state === "pending") return <Badge tone="warning">Pending</Badge>;
    return <Badge tone="positive">Normal</Badge>;
}
