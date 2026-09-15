import { ShieldCheck } from "lucide-react";

import { Badge, Button, SuccessNotice } from "../../../../index";
import type { AccountPanelProps } from "../../types";
import { SettingsSection } from "./SettingsSection";
/**
 * List enrolled factors and offer enrollment, removal and recovery-code actions.
 * @returns The component's rendered content for its current state.
 */
export function SecurityPanel({ data, onAction, notice }: AccountPanelProps) {
    return (
        <SettingsSection
            id="account-security"
            title="Two-factor authentication"
            description="Protect your account with an authenticator app or security key."
            icon={ShieldCheck}
            actions={
                <div className="flex flex-wrap gap-2">
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => onAction("totp")}
                    >
                        Add authenticator app
                    </Button>
                    <Button size="sm" onClick={() => onAction("webauthn")}>
                        Add security key
                    </Button>
                </div>
            }
        >
            {data.factors.length === 0 ? (
                <p className="rounded-lg border border-red-500/25 bg-red-500/10 p-3 text-sm text-red-300">
                    Two-factor authentication is not enabled. Add a security method before
                    using protected homelab services.
                </p>
            ) : (
                <ul className="space-y-2">
                    {data.factors.map((factor) => (
                        <li
                            key={factor.id}
                            className="flex flex-col gap-3 rounded-lg border border-primary-700 bg-primary-900/40 p-3 sm:flex-row sm:items-center sm:justify-between"
                        >
                            <div className="min-w-0 flex-1">
                                <p className="font-medium wrap-break-word">
                                    {factor.label}
                                </p>
                                <p className="text-sm text-primary-300">
                                    {factor.kind === "totp"
                                        ? "Authenticator app"
                                        : "WebAuthn security key"}
                                    {factor.lastUsedAt
                                        ? ` · Last used ${new Date(factor.lastUsedAt).toLocaleString()}`
                                        : ""}
                                </p>
                            </div>
                            <Button
                                size="sm"
                                variant="secondary"
                                onClick={() =>
                                    onAction({
                                        kind: "remove",
                                        id: factor.id,
                                        label: factor.label,
                                    })
                                }
                            >
                                Remove
                            </Button>
                        </li>
                    ))}
                </ul>
            )}
            {data.factors.length > 0 && (
                <div className="flex flex-col gap-3 border-t border-primary-700 pt-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                        <p className="flex items-center gap-2 text-sm font-medium">
                            Recovery codes{" "}
                            <Badge
                                tone={
                                    data.recoveryCodesRemaining > 0
                                        ? "neutral"
                                        : "warning"
                                }
                            >
                                {data.recoveryCodesRemaining} remaining
                            </Badge>
                        </p>
                        <p className="mt-1 text-xs text-primary-400">
                            Keep these offline in case you lose access to your
                            authenticator or key.
                        </p>
                    </div>
                    <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => onAction("recovery")}
                    >
                        Replace recovery codes
                    </Button>
                </div>
            )}
            {notice && <SuccessNotice>{notice}</SuccessNotice>}
        </SettingsSection>
    );
}
