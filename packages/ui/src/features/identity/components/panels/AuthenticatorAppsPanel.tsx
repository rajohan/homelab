import { Smartphone, Plus } from "lucide-react";

import { Button, SuccessNotice } from "../../../../index";
import type { AccountPanelProps } from "../../types";
import { FactorList } from "./FactorList";
import { SettingsSection } from "./SettingsSection";

/**
 * Manage standard six-digit authenticator apps in their own settings card.
 * @returns The app inventory and enrollment action.
 */
export function AuthenticatorAppsPanel({ data, onAction, notice }: AccountPanelProps) {
    return (
        <SettingsSection
            id="account-authenticators"
            title="Authenticator apps"
            description="Use a standard 6-digit authenticator code as a second factor."
            icon={Smartphone}
            actions={
                <Button
                    size="sm"
                    aria-label="Add authenticator app"
                    onClick={() => onAction("totp")}
                >
                    <Plus aria-hidden="true" className="size-4" />
                    Add
                </Button>
            }
        >
            <FactorList data={data} kind="totp" onAction={onAction} />
            {notice && <SuccessNotice>{notice}</SuccessNotice>}
        </SettingsSection>
    );
}
