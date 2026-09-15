import { Brand, Button, ErrorNotice, LoadingState } from "@homelab/ui";
import { AccountSettings, VerificationMethods } from "@homelab/ui/identity";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { SignedInActions } from "../components/SignedInActions";
import { SignInForm } from "../components/SignInForm";
import { AuthLayout } from "../layout/AuthLayout";
import type { AuthPageProps } from "../types";
export function SignInPage({ client, address }: AuthPageProps) {
    const queryClient = useQueryClient();
    const session = useQuery({
        queryKey: ["identity", "session"],
        queryFn: () => client.session(),
        retry: false,
        staleTime: 0,
    });
    async function refresh(): Promise<void> {
        await queryClient.invalidateQueries({ queryKey: ["identity"] });
    }
    if (address.pathname === "/account" && session.data?.authenticated)
        return (
            <main className="mx-auto max-w-5xl p-5 sm:p-10">
                <a
                    href="/sign-in"
                    className="mb-8 inline-flex"
                    aria-label="Homelab sign in"
                >
                    <Brand subtitle="Account security" />
                </a>
                <AccountSettings client={client} signInPath="/sign-in" />
            </main>
        );
    return (
        <AuthLayout title="Sign in">
            {session.isPending && (
                <LoadingState label="Checking your session…" size="sm" />
            )}
            {session.isError && (
                <div className="space-y-3">
                    <ErrorNotice error={session.error} />
                    <Button onClick={() => void refresh()}>Try again</Button>
                </div>
            )}
            {session.data?.mfaRequired && (
                <div className="space-y-4">
                    <p className="text-base text-primary-300">
                        Confirm your second factor to finish signing in.
                    </p>
                    <VerificationMethods
                        client={client}
                        onVerified={() => void refresh()}
                    />
                </div>
            )}
            {session.data?.authenticated && (
                <SignedInActions
                    client={client}
                    address={address}
                    username={session.data.username}
                    onRefresh={refresh}
                />
            )}
            {session.data && !session.data.authenticated && !session.data.mfaRequired && (
                <SignInForm client={client} onComplete={refresh} />
            )}
        </AuthLayout>
    );
}
