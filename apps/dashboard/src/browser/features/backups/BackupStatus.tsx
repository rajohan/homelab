import type { BackupState } from "@homelab/contracts/backups";
import { Badge } from "@homelab/ui";

const presentation = {
    healthy: { label: "Healthy", tone: "positive" },
    running: { label: "Running", tone: "neutral" },
    failed: { label: "Failed", tone: "danger" },
    overdue: { label: "Overdue", tone: "warning" },
    disabled: { label: "Disabled", tone: "neutral" },
    unknown: { label: "Unknown", tone: "warning" },
} as const;

/**
 * Share backup state colors across the overview and detailed inventory.
 * @returns A compact badge with missing health never colored green.
 */
export function BackupStatus({ state }: { readonly state: BackupState }) {
    const display = presentation[state];
    return <Badge tone={display.tone}>{display.label}</Badge>;
}
