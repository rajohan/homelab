import { ShieldOff } from "lucide-react";

import { Button } from "../../../../index";
import type { AccountPanelProps } from "../../types";
import { SettingsSection } from "./SettingsSection";

/**
 * Offer deliberate removal of all enrolled second factors in a separate danger section.
 * @returns The destructive action only when two-step login is enabled.
 */
export function DisableMfaPanel({ data, onAction }: AccountPanelProps) {
    if (data.factors.length === 0) return null;
    return (
        <SettingsSection
            id="account-disable-mfa"
            title="Disable two-step login"
            description="Remove every security key, authenticator app and recovery code. All sessions will be signed out."
            icon={ShieldOff}
            actions={
                <Button
                    size="sm"
                    variant="danger"
                    onClick={() => onAction("disable-mfa")}
                >
                    Disable two-step login
                </Button>
            }
        />
    );
}
