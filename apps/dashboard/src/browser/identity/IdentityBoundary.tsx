import { AuthFrame, Button, LoadingState, Redirect } from "@homelab/ui";
import { useIdentitySession } from "@homelab/ui/identity";
import { IdentityClient } from "@homelab/ui/identity/client";
import { useState, type ReactNode } from "react";

import { AuthorizationDeclined } from "./AuthorizationDeclined";
import { IdentityClientContext } from "./IdentityClientContext";
/**
 * Render private dashboard content only while the current session is verified.
 * @returns The component's rendered content for its current state.
 */
export function IdentityBoundary({ children }: { children: ReactNode }) {
    const [client] = useState(() => new IdentityClient());
    const session = useIdentitySession(client);
    if (globalThis.location.pathname === "/auth/declined")
        return <AuthorizationDeclined />;
    if (session.isPending)
        return (
            <main className="flex min-h-dvh items-center justify-center p-4">
                <LoadingState label="Verifying your session…" />
            </main>
        );
    if (session.isError)
        return (
            <AuthFrame title="Welcome to Homelab">
                <p className="text-sm leading-6 text-primary-300">
                    The identity service is unavailable. Your session has not been
                    verified.
                </p>
                <Button
                    onClick={() => {
                        void session.refetch();
                    }}
                >
                    Try again
                </Button>
            </AuthFrame>
        );
    if (!session.data.authenticated) {
        const { pathname, search, hash } = globalThis.location;
        const query = new URLSearchParams({ returnTo: pathname + search + hash });
        return (
            <main className="flex min-h-dvh items-center justify-center p-4">
                <Redirect
                    to={`/login?${query.toString()}`}
                    label="Taking you to sign-in…"
                />
            </main>
        );
    }
    return (
        <IdentityClientContext
            value={client}
            key={
                session.data.sessionId ??
                session.data.userId ??
                session.data.username ??
                "authenticated"
            }
        >
            {children}
        </IdentityClientContext>
    );
}
