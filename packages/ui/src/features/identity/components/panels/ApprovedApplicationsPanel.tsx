import { oidcScopeDescriptions } from "@homelab/contracts";
import { AppWindow, Trash2 } from "lucide-react";

import { IconButton, SuccessNotice } from "../../../../index";
import { formatDateTime } from "../../../../lib/formatDateTime";
import type { AccountPanelProps } from "../../types";
import { SettingsSection } from "./SettingsSection";

/**
 * List remembered app approvals and allow each app's access to be revoked.
 * @returns Account-owned approvals with shared permission labels and timestamps.
 */
export function ApprovedApplicationsPanel({ data, onAction, notice }: AccountPanelProps) {
    const applications = data.applications ?? [];
    return (
        <SettingsSection
            id="account-applications"
            title="Approved applications"
            description="Approvals are remembered across sign-ins. Apps must ask again for additional access."
            icon={AppWindow}
        >
            {applications.length === 0 ? (
                <p className="text-sm text-primary-400">No applications approved.</p>
            ) : (
                <ul className="space-y-2">
                    {applications.map((app) => (
                        <li
                            key={app.id}
                            className="flex items-start justify-between gap-3 rounded-lg border border-primary-700 bg-primary-900/40 p-3"
                        >
                            <div className="min-w-0 flex-1">
                                <p className="font-medium wrap-anywhere">{app.name}</p>
                                <p className="mt-1 text-xs text-primary-400">
                                    Approved {formatDateTime(app.approvedAt)}
                                </p>
                                <ul className="mt-2 list-disc space-y-1 pl-5 text-xs text-primary-300">
                                    {app.scopes.map((scope) => (
                                        <li key={scope}>
                                            {oidcScopeDescriptions[scope] ?? scope}
                                        </li>
                                    ))}
                                </ul>
                            </div>
                            <IconButton
                                size="sm"
                                variant="danger"
                                icon={Trash2}
                                label={`Revoke ${app.name}`}
                                onClick={() =>
                                    onAction({
                                        kind: "application",
                                        id: app.id,
                                        label: app.name,
                                    })
                                }
                            />
                        </li>
                    ))}
                </ul>
            )}
            {notice && <SuccessNotice>{notice}</SuccessNotice>}
        </SettingsSection>
    );
}
