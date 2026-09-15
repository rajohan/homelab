import { AuthFrame, Button, LoadingState, buttonStyles } from "@homelab/ui";
import { useIdentitySession } from "@homelab/ui/identity";
import { IdentityClient } from "@homelab/ui/identity/client";
import { Fragment, useState, type ReactNode } from "react";
/**
 * Render private dashboard content only while the current session is verified.
 * @returns The component's rendered content for its current state.
 */
export function IdentityBoundary({ children }: { children: ReactNode }) {
    const [client] = useState(() => new IdentityClient());
    const session = useIdentitySession(client);
    if (session.isPending)
        return (
            <main className="flex min-h-dvh items-center justify-center p-4">
                <LoadingState label="Verifying your session…" />
            </main>
        );
    if (session.isError || !session.data.authenticated)
        return (
            <AuthFrame title="Welcome to Homelab">
                <p className="text-sm leading-6 text-primary-300">
                    {session.isError
                        ? "The identity service is unavailable. Your session has not been verified."
                        : "Sign in to manage your account and infrastructure."}
                </p>
                {session.isError ? (
                    <Button
                        onClick={() => {
                            void session.refetch();
                        }}
                    >
                        Try again
                    </Button>
                ) : (
                    <a
                        className={buttonStyles({ fullWidth: true })}
                        href="/login?returnTo=/settings"
                    >
                        Sign in
                    </a>
                )}
            </AuthFrame>
        );
    return (
        <Fragment
            key={
                session.data.sessionId ??
                session.data.userId ??
                session.data.username ??
                "authenticated"
            }
        >
            {children}
        </Fragment>
    );
}
