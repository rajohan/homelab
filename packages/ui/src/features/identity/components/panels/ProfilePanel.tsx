import { UserRound } from "lucide-react";

import { Badge, Button, Card, SectionHeader, SuccessNotice } from "../../../../index";
import type { AccountPanelProps } from "../../types";
/**
 * Show the account identity and controls for changing verified email and password.
 * @returns The component's rendered content for its current state.
 */
export function ProfilePanel({ data, onAction, notice }: AccountPanelProps) {
    return (
        <Card id="account-profile" className="space-y-5">
            <SectionHeader
                title="Account"
                description="Your profile and sign-in details."
                icon={UserRound}
            />
            <dl className="grid gap-5 rounded-lg border border-primary-700 bg-primary-900/40 p-4 text-sm sm:grid-cols-2">
                <div>
                    <dt className="text-sm text-primary-300">Username</dt>
                    <dd className="mt-1 font-medium wrap-break-word">
                        {data.user.username}
                    </dd>
                </div>
                <div>
                    <dt className="text-sm text-primary-300">Email</dt>
                    <dd className="mt-1 break-all">{data.user.email}</dd>
                    <dd className="mt-1 text-sm text-primary-300">
                        <Badge tone={data.user.emailVerified ? "positive" : "warning"}>
                            {data.user.emailVerified ? "Verified" : "Not verified"}
                        </Badge>
                    </dd>
                </div>
            </dl>
            <div className="flex flex-wrap gap-3">
                <Button variant="secondary" onClick={() => onAction("email")}>
                    {data.user.emailVerified ? "Change email" : "Verify or change email"}
                </Button>
                <Button onClick={() => onAction("password")}>Change password</Button>
            </div>
            {notice && <SuccessNotice>{notice}</SuccessNotice>}
        </Card>
    );
}
