import type { OidcConsent } from "@homelab/contracts";
import { Button, ErrorNotice, LoadingState, Redirect } from "@homelab/ui";
import { IdentityError, type IdentityClient } from "@homelab/ui/identity/client";
import { useEffect, useRef, useState } from "react";

import { AuthLayout } from "../layout/AuthLayout";
import { restartSignIn } from "../navigation/restartSignIn";
import { signInDestination } from "../navigation/signInDestination";
import { submitOidcConsent } from "../navigation/submitOidcConsent";
import { AccountActions } from "./AccountActions";
import { OidcConsentRequest } from "./OidcConsentRequest";

/**
 * Complete verified sign-in, asking for explicit app consent when the provider requires it.
 * @returns Navigation progress or a retryable handoff error.
 */
export function SignInRedirect({
    client,
    address,
    onSignedOut,
}: {
    client: IdentityClient;
    address: URL;
    onSignedOut: () => Promise<void>;
}) {
    const pending = useRef<Promise<string | OidcConsent> | undefined>(undefined);
    const [attempt, setAttempt] = useState(0);
    const [destination, setDestination] = useState<string>();
    const [consent, setConsent] = useState<OidcConsent>();
    const [failure, setFailure] = useState<unknown>();
    useEffect(() => {
        // React may replay effects; one mounted handoff must only submit once.
        pending.current ??= signInDestination(client, address);
        let active = true;
        void pending.current.then(
            (target) => {
                if (active) {
                    if (typeof target === "string") setDestination(target);
                    else setConsent(target);
                }
                return target;
            },
            (error: unknown) => {
                if (active) setFailure(error);
            }
        );
        return () => {
            active = false;
        };
    }, [client, address, attempt]);

    if (destination) return <Redirect to={destination} label="Completing sign-in…" />;
    if (consent)
        return (
            <AuthLayout
                title="Approve access?"
                description={consent.clientName + " wants to use your Homelab account."}
                authenticated
            >
                <OidcConsentRequest
                    consent={consent}
                    onDecision={async (decision) => {
                        try {
                            setDestination(
                                await submitOidcConsent(
                                    client,
                                    address,
                                    consent,
                                    decision
                                )
                            );
                        } catch (error) {
                            if (
                                error instanceof IdentityError &&
                                ["INTERACTION_EXPIRED", "CONSENT_CONFLICT"].includes(
                                    error.code
                                )
                            ) {
                                setConsent(undefined);
                                setFailure(error);
                            } else throw error;
                        }
                    }}
                />
            </AuthLayout>
        );
    if (failure !== undefined)
        return (
            <AuthLayout title="Sign-in not completed" authenticated>
                <div className="space-y-4">
                    <ErrorNotice error={failure} />
                    {failure instanceof IdentityError &&
                    ["INTERACTION_EXPIRED", "CONSENT_CONFLICT"].includes(failure.code) ? (
                        <Button
                            fullWidth
                            onClick={() => {
                                setFailure(undefined);
                                void restartSignIn(client, address).then(
                                    setDestination,
                                    (error: unknown) => setFailure(error)
                                );
                            }}
                        >
                            Start a new sign-in
                        </Button>
                    ) : (
                        <Button
                            fullWidth
                            onClick={() => {
                                pending.current = undefined;
                                setFailure(undefined);
                                setAttempt(attempt + 1);
                            }}
                        >
                            Try again
                        </Button>
                    )}
                    <AccountActions client={client} onSignedOut={onSignedOut} />
                </div>
            </AuthLayout>
        );
    return (
        <AuthLayout title="Completing sign-in" authenticated>
            <LoadingState label="Completing sign-in…" />
        </AuthLayout>
    );
}
