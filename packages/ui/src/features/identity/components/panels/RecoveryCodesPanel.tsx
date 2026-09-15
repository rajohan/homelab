import { ShieldCheck, RefreshCw } from "lucide-react";

import { Badge, Button, SuccessNotice } from "../../../../index";
import type { AccountPanelProps } from "../../types";
import { SettingsSection } from "./SettingsSection";

/**
 * Present offline recovery separately from the enrolled authenticators.
 * @returns The remaining code count and guarded replacement action.
 */
export function RecoveryCodesPanel({ data, onAction, notice }: AccountPanelProps) {
    return (
        <SettingsSection
            id="account-recovery"
            title="Recovery codes"
            description="Store these one-time codes offline. Full codes are shown only when generated."
            icon={ShieldCheck}
            actions={
                <Button
                    size="sm"
                    variant="secondary"
                    disabled={data.factors.length === 0}
                    onClick={() => onAction("recovery")}
                >
                    <RefreshCw aria-hidden="true" className="size-4" />
                    Create new codes
                </Button>
            }
        >
            <Badge tone={data.recoveryCodesRemaining > 0 ? "neutral" : "warning"}>
                {data.recoveryCodesRemaining} unused
            </Badge>
            {notice && <SuccessNotice>{notice}</SuccessNotice>}
        </SettingsSection>
    );
}
