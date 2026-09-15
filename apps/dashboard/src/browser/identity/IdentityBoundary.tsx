import { AuthFrame, Button, LoadingState, buttonStyles } from "@homelab/ui";
import { IdentityClient } from "@homelab/ui/identity/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState, type ReactNode } from "react";
export function IdentityBoundary({ children }: { children: ReactNode }) {
    const queryClient = useQueryClient();
    const [client] = useState(() => new IdentityClient());
    const session = useQuery({
        queryKey: ["identity", "session"],
        queryFn: async () => {
            const result = await client.session();
            const previous = queryClient.getQueryData<
                Awaited<ReturnType<IdentityClient["session"]>>
            >(["identity", "session"]);
            if (
                !result.authenticated ||
                previous?.userId !== result.userId ||
                previous?.username !== result.username
            )
                queryClient.removeQueries({
                    predicate: (query) =>
                        !(
                            query.queryKey[0] === "identity" &&
                            query.queryKey[1] === "session"
                        ),
                });
            return result;
        },
        retry: false,
        refetchOnWindowFocus: true,
        refetchInterval: 60_000,
    });
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
        <Fragment key={session.data.userId ?? session.data.username ?? "authenticated"}>
            {children}
        </Fragment>
    );
}
