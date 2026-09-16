import { Button, ErrorNotice, LoadingState } from "@homelab/ui";
import { VerificationMethods, useIdentitySession } from "@homelab/ui/identity";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { AccountActions } from "../components/AccountActions";
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
    if (!session.isError && session.data?.mfaRequired) {
        return (
            <VerificationMethods
                key={identityKey}
                client={client}
                onVerified={() => void finish()}
                renderFrame={(content, description) => (
                    <AuthLayout title="Verify your identity" description={description}>
                        <div className="space-y-4">
                            {content}
                            <AccountActions client={client} onSignedOut={refresh} />
                        </div>
                    </AuthLayout>
                )}
            />
        );
    }
    if (!session.isError && session.data?.authenticated && handoff) {
        return (
            <SignInRedirect
                key={identityKey + address.href}
                client={client}
                address={address}
                onSignedOut={refresh}
            />
        );
    }
    const description = session.data?.authenticated ? (
        <>
            Signed in as{" "}
            <strong className="font-semibold text-primary-200">
                {session.data.username}
            </strong>
            .
        </>
    ) : undefined;
    return (
        <AuthLayout
            key={identityKey}
            description={description}
            authenticated={session.data?.authenticated ?? false}
            title={session.data?.authenticated ? "Your account" : "Sign in"}
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
            {!session.isError && session.data?.authenticated && (
                <SignedInActions client={client} onRefresh={refresh} />
            )}
            {!session.isError &&
                session.data &&
                !session.data.authenticated &&
                !session.data.mfaRequired && (
                    <SignInForm client={client} onComplete={finish} />
                )}
        </AuthLayout>
    );
}
