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
            description="Verified address used for account security and password recovery."
            icon={Mail}
            actions={
                <Button size="sm" variant="secondary" onClick={() => onAction("email")}>
                    {data.user.emailVerified ? "Change email" : "Verify email"}
                </Button>
            }
        >
            <p className="flex flex-wrap items-center gap-2 text-sm">
                <span className="break-all">{data.user.email}</span>
                <Badge tone={data.user.emailVerified ? "positive" : "warning"}>
                    {data.user.emailVerified ? "Verified" : "Unverified"}
                </Badge>
            </p>
            {notice && <SuccessNotice>{notice}</SuccessNotice>}
        </SettingsSection>
    );
}
