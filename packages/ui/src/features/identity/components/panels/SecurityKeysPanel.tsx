import { Fingerprint, Plus } from "lucide-react";

import { Button, SuccessNotice } from "../../../../index";
import type { AccountPanelProps } from "../../types";
import { FactorList } from "./FactorList";
import { SettingsSection } from "./SettingsSection";

/**
 * Manage phishing-resistant security keys independently from authenticator apps.
 * @returns The key inventory and enrollment action.
 */
export function SecurityKeysPanel({ data, onAction, notice }: AccountPanelProps) {
    return (
        <SettingsSection
            id="account-keys"
            title="Security keys"
            description="Register named security keys and keep a backup key separately."
            icon={Fingerprint}
            actions={
                <Button
                    size="sm"
                    aria-label="Add security key"
                    onClick={() => onAction("webauthn")}
                >
                    <Plus aria-hidden="true" className="size-4" />
                    Add
                </Button>
            }
        >
            <FactorList data={data} kind="webauthn" onAction={onAction} />
            {notice && <SuccessNotice>{notice}</SuccessNotice>}
        </SettingsSection>
    );
}
