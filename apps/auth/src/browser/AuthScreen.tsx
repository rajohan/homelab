import {
    AccountSettings,
    ErrorNotice,
    FieldsForm,
    VerificationMethods,
} from "@homelab/identity-ui";
import type { IdentityClient } from "@homelab/identity-ui/client";
import { Button, Card } from "@homelab/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import * as v from "valibot";

export function AuthScreen({
    client,
    address,
    token,
}: {
    client: IdentityClient;
    address: URL;
    token: string | null;
}) {
    const queryClient = useQueryClient();
    const session = useQuery({
        queryKey: ["identity", "session"],
        queryFn: () => client.session(),
        retry: false,
        staleTime: 0,
    });
    const [notice, setNotice] = useState("");
    const [failure, setFailure] = useState<unknown>();
    const [busy, setBusy] = useState(false);
    const recoveryPage =
        address.pathname === "/forgot-password" ||
        address.pathname === "/reset-password" ||
        address.pathname === "/verify-email";
    async function refresh(): Promise<void> {
        await queryClient.invalidateQueries({ queryKey: ["identity"] });
    }

    async function proceed(): Promise<void> {
        setFailure(undefined);
        setBusy(true);
        try {
            if (address.pathname === "/sso") {
                const target = address.searchParams.get("target");
                const nonce = address.searchParams.get("nonce");
                const result = v.parse(
                    v.object({ redirect: v.string() }),
                    await client.request("/api/sso/complete", { target, nonce })
                );
                const destination = new URL(result.redirect);
                if (
                    !target ||
                    destination.origin !== new URL(target).origin ||
                    destination.pathname !== "/.homelab/sso/callback"
                )
                    throw new Error("Invalid return address.");
                globalThis.location.assign(destination.href);
            } else if (address.searchParams.has("interaction")) {
                const result = v.parse(
                    v.object({ redirect: v.string() }),
                    await client.request("/sign-in/complete", {})
                );
                const destination = new URL(result.redirect, globalThis.location.origin);
                if (destination.origin !== globalThis.location.origin)
                    throw new Error("Invalid authorization return address.");
                globalThis.location.assign(destination.href);
            } else globalThis.location.assign("/account");
        } catch (error) {
            setFailure(error);
            setBusy(false);
        }
    }

    if (address.pathname === "/account" && session.data?.authenticated)
        return (
            <main className="mx-auto max-w-5xl p-5 sm:p-10">
                <AccountSettings client={client} signInPath="/sign-in" />
            </main>
        );
    return (
        <main className="grid min-h-screen place-items-center px-4 py-10">
            <div className="w-full max-w-md space-y-5">
                <a
                    className="block text-center text-2xl font-semibold tracking-tight text-blue-900"
                    href="/sign-in"
                >
                    Homelab
                </a>
                <Card className="space-y-5">
                    <h1 className="text-2xl font-semibold">
                        {pageTitle(address.pathname)}
                    </h1>
                    {notice && (
                        <output className="text-base text-emerald-800">{notice}</output>
                    )}
                    {failure !== undefined && <ErrorNotice error={failure} />}
                    {address.pathname === "/forgot-password" && (
                        <FieldsForm
                            fields={[
                                {
                                    name: "username",
                                    label: "Username",
                                    autoComplete: "username",
                                    maximum: 100,
                                },
                            ]}
                            submitLabel="Send reset link"
                            onSubmit={async (values) => {
                                await client.request("/api/password/request-reset", {
                                    username: values.username,
                                });
                                setNotice(
                                    "If your account has a verified email, a reset link will be sent."
                                );
                            }}
                        />
                    )}
                    {address.pathname === "/reset-password" &&
                        (token ? (
                            <FieldsForm
                                fields={[
                                    {
                                        name: "newPassword",
                                        label: "New password",
                                        type: "password",
                                        autoComplete: "new-password",
                                        minimum: 12,
                                    },
                                    {
                                        name: "confirmPassword",
                                        label: "Repeat new password",
                                        type: "password",
                                        autoComplete: "new-password",
                                        minimum: 12,
                                    },
                                ]}
                                submitLabel="Reset password"
                                onSubmit={async (values) => {
                                    await client.request("/api/password/reset", {
                                        token,
                                        password: values.newPassword,
                                    });
                                    setNotice(
                                        "Your password was reset. Sign in using your existing two-factor method."
                                    );
                                }}
                            />
                        ) : (
                            <p role="alert">
                                This reset link is missing its token. Request another
                                email.
                            </p>
                        ))}
                    {address.pathname === "/verify-email" &&
                        (token ? (
                            <FieldsForm
                                fields={[]}
                                submitLabel="Verify email"
                                onSubmit={async () => {
                                    await client.request("/api/email/verify", { token });
                                    setNotice("Your email has been verified.");
                                }}
                            />
                        ) : (
                            <p role="alert">
                                This verification link is missing its token. Request
                                another email.
                            </p>
                        ))}
                    {!recoveryPage && session.isPending && (
                        <output>Checking your session…</output>
                    )}
                    {!recoveryPage && session.isError && (
                        <div className="space-y-3">
                            <ErrorNotice error={session.error} />
                            <Button onClick={() => void refresh()}>Try again</Button>
                        </div>
                    )}
                    {!recoveryPage && session.data?.mfaRequired && (
                        <div className="space-y-4">
                            <p className="text-base text-slate-600">
                                Confirm your second factor to finish signing in.
                            </p>
                            <VerificationMethods
                                client={client}
                                onVerified={() => void refresh()}
                            />
                        </div>
                    )}
                    {!recoveryPage && session.data?.authenticated && (
                        <div className="space-y-4">
                            <p className="text-base">
                                Signed in as <strong>{session.data.username}</strong>.
                            </p>
                            <Button disabled={busy} onClick={() => void proceed()}>
                                {busy ? "Continuing…" : "Continue"}
                            </Button>
                            <a
                                className="block text-sm text-blue-700 underline"
                                href="/account"
                            >
                                Manage account security
                            </a>
                            <Button
                                disabled={busy}
                                onClick={() => {
                                    void client
                                        .request("/api/logout", {})
                                        .then(refresh)
                                        .catch(setFailure);
                                }}
                            >
                                Use another account
                            </Button>
                        </div>
                    )}
                    {!recoveryPage &&
                        session.data &&
                        !session.data.authenticated &&
                        !session.data.mfaRequired && (
                            <FieldsForm
                                fields={[
                                    {
                                        name: "username",
                                        label: "Username",
                                        autoComplete: "username",
                                        maximum: 100,
                                    },
                                    {
                                        name: "password",
                                        label: "Password",
                                        type: "password",
                                        autoComplete: "current-password",
                                        minimum: 8,
                                    },
                                ]}
                                submitLabel="Sign in"
                                onSubmit={async (values) => {
                                    await client.request("/api/login", {
                                        username: values.username,
                                        password: values.password,
                                    });
                                    await refresh();
                                }}
                            />
                        )}
                    <a
                        className="block text-sm text-blue-700 underline"
                        href={recoveryPage ? "/sign-in" : "/forgot-password"}
                    >
                        {recoveryPage ? "Return to sign in" : "Forgot your password?"}
                    </a>
                </Card>
            </div>
        </main>
    );
}

function pageTitle(path: string): string {
    if (path === "/forgot-password") return "Reset your password";
    if (path === "/reset-password") return "Choose a new password";
    if (path === "/verify-email") return "Verify your email";
    return "Sign in";
}
