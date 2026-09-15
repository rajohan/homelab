import { UserRound } from "lucide-react";

import { Badge, Button, SuccessNotice } from "../../../../index";
import type { AccountPanelProps } from "../../types";
import { SettingsSection } from "./SettingsSection";
/**
 * Show sign-in details with each account action beside the value it changes.
 * @returns Account details and action-local verification feedback.
 */
export function ProfilePanel({ data, onAction, notice }: AccountPanelProps) {
    return (
        <SettingsSection
            id="account-profile"
            title="Account"
            description="Your username, recovery email and password."
            icon={UserRound}
        >
            <dl className="divide-y divide-primary-700 text-sm">
                <div className="flex flex-col gap-1 pb-4 sm:flex-row sm:gap-6">
                    <dt className="w-32 shrink-0 text-primary-400">Username</dt>
                    <dd className="min-w-0 font-medium wrap-anywhere">
                        {data.user.username}
                    </dd>
                </div>
                <div className="flex flex-col gap-3 py-4 sm:flex-row sm:items-center sm:justify-between">
                    <div className="min-w-0">
                        <dt className="text-primary-400">Email address</dt>
                        <dd className="mt-1 flex flex-wrap items-center gap-2">
                            <span className="break-all">{data.user.email}</span>
                            <Badge
                                tone={data.user.emailVerified ? "positive" : "warning"}
                            >
                                {data.user.emailVerified ? "Verified" : "Not verified"}
                            </Badge>
                        </dd>
                        <dd className="mt-1 text-xs text-primary-400">
                            Used for account verification and password recovery.
                        </dd>
                    </div>
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => onAction("email")}
                    >
                        {data.user.emailVerified ? "Change email" : "Verify email"}
                    </Button>
                </div>
                <div className="flex flex-col gap-3 pt-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                        <dt className="font-medium">Password</dt>
                        <dd className="mt-1 text-xs text-primary-400">
                            Choose a strong password you do not use elsewhere.
                        </dd>
                    </div>
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => onAction("password")}
                    >
                        Change password
                    </Button>
                </div>
            </dl>
            {notice && <SuccessNotice>{notice}</SuccessNotice>}
        </SettingsSection>
    );
}
