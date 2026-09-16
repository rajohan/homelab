import { KeyRound } from "lucide-react";

import { Button, SuccessNotice } from "../../../../index";
import type { AccountPanelProps } from "../../types";
import { SettingsSection } from "./SettingsSection";

/**
 * Present the password action separately from the recovery email and second factors.
 * @returns Password guidance and action-local feedback.
 */
export function PasswordPanel({ onAction, notice }: AccountPanelProps) {
    return (
        <SettingsSection
            id="account-password"
            title="Account password"
            description="Changing it signs out all other sessions. Forgotten passwords use a short-lived email link."
            icon={KeyRound}
            actions={
                <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onAction("password")}
                >
                    Change password
                </Button>
            }
        >
            {notice && <SuccessNotice>{notice}</SuccessNotice>}
        </SettingsSection>
    );
}
