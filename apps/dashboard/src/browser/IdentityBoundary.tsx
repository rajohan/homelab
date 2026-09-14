import { IdentityClient } from "@homelab/identity-ui/client";
import { Button, Card } from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
export function IdentityBoundary({ children }: { children: ReactNode }) {
    const [client] = useState(() => new IdentityClient());
    const session = useQuery({
        queryKey: ["dashboard-session"],
        queryFn: () => client.session(),
        retry: false,
        refetchOnWindowFocus: true,
        refetchInterval: 60_000,
    });
    if (session.isPending)
        return (
            <main className="mx-auto max-w-xl p-8" aria-live="polite">
                Verifying your session…
            </main>
        );
    if (session.isError || !session.data.authenticated)
        return (
            <main className="mx-auto max-w-xl p-8">
                <Card>
                    <h1 className="mb-4 text-2xl font-semibold">Welcome to Homelab</h1>
                    <p className="mb-6">
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
                            className="font-medium text-blue-800 underline"
                            href="/login?returnTo=/settings"
                        >
                            Sign in
                        </a>
                    )}
                </Card>
            </main>
        );
    return children;
}
