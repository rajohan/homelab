import { Button, ErrorNotice, LoadingState } from "@homelab/ui";
import { VerificationMethods, useIdentitySession } from "@homelab/ui/identity";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { SignedInActions } from "../components/SignedInActions";
import { SignInForm } from "../components/SignInForm";
import { SignInRedirect } from "../components/SignInRedirect";
import { AuthLayout } from "../layout/AuthLayout";
import type { AuthPageProps } from "../types";

/**
 * Coordinate password and MFA verification, returning completed sign-ins to their app.
 * @returns Authentication progress or the account menu for a direct signed-in visit.
 */
export function SignInPage({ client, address }: AuthPageProps) {
    const queryClient = useQueryClient();
    const session = useIdentitySession(client);
    const [completed, setCompleted] = useState(false);
    const identityKey =
        session.data?.sessionId ??
        session.data?.userId ??
        session.data?.username ??
        "anonymous";
    const handoff =
        completed ||
        address.pathname === "/sso" ||
        address.searchParams.has("interaction");

    async function refresh(): Promise<void> {
        await queryClient.invalidateQueries({ queryKey: ["identity"] });
    }
    async function finish(): Promise<void> {
        setCompleted(true);
        await refresh();
    }
    const signedOutTitle = session.data?.mfaRequired ? "Verify your identity" : "Sign in";
    const signedInTitle = handoff ? "Redirecting" : "Your account";
    return (
        <AuthLayout
            key={identityKey}
            description={
                session.data?.mfaRequired
                    ? "Choose a verification method to finish signing in."
                    : undefined
            }
            authenticated={session.data?.authenticated ?? false}
            title={session.data?.authenticated ? signedInTitle : signedOutTitle}
        >
            {session.isPending && (
                <LoadingState label="Checking your session…" size="sm" />
            )}
            {session.isError && (
                <div className="space-y-3">
                    <ErrorNotice error={session.error} />
                    <Button onClick={() => void refresh()}>Try again</Button>
                </div>
            )}
            {!session.isError && session.data?.mfaRequired && (
                <div className="space-y-4">
                    <VerificationMethods
                        client={client}
                        onVerified={() => void finish()}
                    />
                </div>
            )}
            {!session.isError &&
                session.data?.authenticated &&
                (handoff ? (
                    <SignInRedirect
                        key={address.href}
                        client={client}
                        address={address}
                        onSignedOut={refresh}
                    />
                ) : (
                    <SignedInActions
                        client={client}
                        username={session.data.username}
                        onRefresh={refresh}
                    />
                ))}
            {!session.isError &&
                session.data &&
                !session.data.authenticated &&
                !session.data.mfaRequired && (
                    <SignInForm client={client} onComplete={finish} />
                )}
        </AuthLayout>
    );
}
