import {
    oidcScopeDescriptions,
    type OidcConsent,
    type OidcConsentDecision,
} from "@homelab/contracts";
import { ActionGroup, Button, ErrorNotice } from "@homelab/ui";
import { useState } from "react";

/**
 * Ask before granting an OIDC app the scopes validated by the identity server.
 * @param props - The server-owned request details and explicit decision handler.
 * @returns The consent page content; opening it never approves access.
 */
export function OidcConsentRequest({
    consent,
    onDecision,
}: {
    readonly consent: OidcConsent;
    readonly onDecision: (decision: OidcConsentDecision["decision"]) => Promise<void>;
}) {
    const [pending, setPending] = useState<OidcConsentDecision["decision"]>();
    const [error, setError] = useState<unknown>();
    async function decide(decision: OidcConsentDecision["decision"]): Promise<void> {
        if (pending) return;
        setPending(decision);
        setError(undefined);
        try {
            await onDecision(decision);
        } catch (error) {
            setError(error);
        } finally {
            setPending(undefined);
        }
    }
    return (
        <div className="space-y-4">
            <div className="space-y-1 rounded-lg border border-primary-700 bg-primary-900 p-3 text-sm wrap-anywhere">
                <p className="text-primary-200">
                    Signed in as <strong>{consent.username}</strong>.
                </p>
                <p className="text-primary-400">{consent.redirectOrigin}</p>
            </div>
            <div>
                <p className="mb-2 text-sm font-medium text-primary-200">
                    Requested access
                </p>
                <ul className="list-disc space-y-2 pl-5 text-sm text-primary-300">
                    {consent.scopes.map((scope) => (
                        <li key={scope}>{oidcScopeDescriptions[scope] ?? scope}</li>
                    ))}
                </ul>
            </div>
            {error !== undefined && <ErrorNotice error={error} />}
            <ActionGroup>
                <Button
                    disabled={pending !== undefined}
                    busy={pending === "approve"}
                    onClick={() => void decide("approve")}
                >
                    Approve
                </Button>
                <Button
                    variant="secondary"
                    disabled={pending !== undefined}
                    busy={pending === "deny"}
                    onClick={() => void decide("deny")}
                >
                    Deny
                </Button>
            </ActionGroup>
        </div>
    );
}
