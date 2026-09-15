import { Mail } from "lucide-react";

import { Badge, Button, SuccessNotice } from "../../../../index";
import type { AccountPanelProps } from "../../types";
import { SettingsSection } from "./SettingsSection";

/**
 * Keep recovery-email details and verification feedback together.
 * @returns The account email with its verification and change controls.
 */
export function ProfilePanel({ data, onAction, notice }: AccountPanelProps) {
    return (
        <SettingsSection
            id="account-profile"
            title="Account email"
            description="Used for account security and password recovery."
            icon={Mail}
            badge={
                <Badge tone={data.user.emailVerified ? "positive" : "warning"}>
                    {data.user.emailVerified ? "Verified" : "Unverified"}
                </Badge>
            }
            actions={
                <Button size="sm" variant="secondary" onClick={() => onAction("email")}>
                    {data.user.emailVerified ? "Change email" : "Verify email"}
                </Button>
            }
        >
            <p className="rounded-lg border border-primary-700 bg-primary-900/40 px-4 py-3 text-sm font-medium wrap-anywhere text-primary-100">
                {data.user.email}
            </p>
            {notice && <SuccessNotice>{notice}</SuccessNotice>}
        </SettingsSection>
    );
}
