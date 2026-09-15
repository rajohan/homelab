import { ShieldCheck } from "lucide-react";

import { Badge, SuccessNotice } from "../../../../index";
import type { AccountPanelProps } from "../../types";
import { SettingsSection } from "./SettingsSection";

/**
 * Summarize two-step login without mixing enrollment, recovery or account actions.
 * @returns The account's second-factor status.
 */
export function SecurityPanel({ data, notice }: AccountPanelProps) {
    return (
        <SettingsSection
            id="account-security"
            title="Two-step login"
            description="Security keys are phishing-resistant. Authenticator apps are supported as an alternative."
            icon={ShieldCheck}
            actions={
                <Badge tone={data.factors.length > 0 ? "positive" : "warning"}>
                    {data.factors.length > 0 ? "Enabled" : "Not enabled"}
                </Badge>
            }
        >
            <p className="text-sm text-primary-400">
                Signed in as{" "}
                <strong className="font-medium text-primary-200">
                    {data.user.username}
                </strong>
                .
            </p>
            {notice && <SuccessNotice>{notice}</SuccessNotice>}
        </SettingsSection>
    );
}
