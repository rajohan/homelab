import { Button, Card } from "../../../../index";
import type { AccountPanelProps } from "../../types";
export function SecurityPanel({ data, onAction }: AccountPanelProps) {
    return (
        <Card id="account-security" className="space-y-5">
            <div>
                <h2 className="text-xl font-semibold">Security methods</h2>
                <p className="mt-2 text-base text-slate-600">
                    Use an authenticator app or a security key. Keep a recovery method
                    available before removing your last key.
                </p>
            </div>
            {data.factors.length === 0 ? (
                <p className="rounded-lg bg-amber-50 p-3 text-base text-amber-950">
                    Two-factor authentication is not enabled. Add a security method before
                    using protected homelab services.
                </p>
            ) : (
                <ul className="divide-y divide-slate-200">
                    {data.factors.map((factor) => (
                        <li
                            key={factor.id}
                            className="flex flex-wrap items-center justify-between gap-3 py-3"
                        >
                            <div>
                                <p className="font-medium">{factor.label}</p>
                                <p className="text-sm text-slate-600">
                                    {factor.kind === "totp"
                                        ? "Authenticator app"
                                        : "WebAuthn security key"}
                                    {factor.lastUsedAt
                                        ? ` · Last used ${new Date(factor.lastUsedAt).toLocaleString()}`
                                        : ""}
                                </p>
                            </div>
                            <Button
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
                <Button onClick={() => onAction("totp")}>Add authenticator app</Button>
                <Button onClick={() => onAction("webauthn")}>Add security key</Button>
            </div>
            {data.factors.length > 0 && (
                <div className="border-t border-slate-200 pt-4">
                    <p className="mb-3 text-base">
                        {data.recoveryCodesRemaining} recovery codes remaining.
                    </p>
                    <Button onClick={() => onAction("recovery")}>
                        Replace recovery codes
                    </Button>
                </div>
            )}
        </Card>
    );
}
