import { ShieldCheck } from "lucide-react";

import { Button, Card, SectionHeader } from "../../../../index";
import type { AccountPanelProps } from "../../types";
export function SecurityPanel({ data, onAction }: AccountPanelProps) {
    return (
        <Card id="account-security" className="space-y-5">
            <SectionHeader
                title="Security methods"
                description="Add an authenticator or security key. Keep a recovery method available before removing your last key."
                icon={ShieldCheck}
            />
            {data.factors.length === 0 ? (
                <p className="rounded-lg border border-red-500/25 bg-red-500/10 p-3 text-sm text-red-300">
                    Two-factor authentication is not enabled. Add a security method before
                    using protected homelab services.
                </p>
            ) : (
                <ul className="divide-y divide-primary-700">
                    {data.factors.map((factor) => (
                        <li
                            key={factor.id}
                            className="flex flex-wrap items-center justify-between gap-3 py-3"
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
                                variant="ghost"
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
            <div className="flex flex-wrap gap-3">
                <Button variant="secondary" onClick={() => onAction("totp")}>
                    Add authenticator app
                </Button>
                <Button onClick={() => onAction("webauthn")}>Add security key</Button>
            </div>
            {data.factors.length > 0 && (
                <div className="border-t border-primary-700 pt-4">
                    <p className="mb-3 text-base">
                        {data.recoveryCodesRemaining} recovery codes remaining.
                    </p>
                    <Button variant="secondary" onClick={() => onAction("recovery")}>
                        Replace recovery codes
                    </Button>
                </div>
            )}
        </Card>
    );
}
