import { Button, Card } from "@homelab/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";
import * as v from "valibot";

import type { IdentityClient } from "./client";
import { IdentityError } from "./client";
import { ErrorNotice, FieldsForm, Modal } from "./controls";
import { SecurityPrompt } from "./SecurityPrompt";

type Action =
    | "password"
    | "email"
    | "totp"
    | "webauthn"
    | "recovery"
    | "others"
    | "all"
    | { readonly kind: "remove"; readonly id: string; readonly label: string }
    | { readonly kind: "session"; readonly id: string; readonly label: string };

export function AccountSettings({
    client,
    signInPath = "/login",
}: {
    client: IdentityClient;
    signInPath?: string;
}) {
    const queryClient = useQueryClient();
    const account = useQuery({
        queryKey: ["identity", "account"],
        queryFn: () => client.snapshot(),
        retry: false,
        staleTime: 0,
    });
    const [action, setAction] = useState<Action>();
    const [notice, setNotice] = useState("");
    const [recovery, setRecovery] = useState<readonly string[]>();
    const [enrollment, setEnrollment] = useState<{
        token: string;
        secret: string;
        uri: string;
    }>();

    async function refresh(message: string): Promise<void> {
        setAction(undefined);
        setEnrollment(undefined);
        setNotice(message);
        await queryClient.invalidateQueries({ queryKey: ["identity"] });
    }
    function closeAction(): void {
        client.cancelActions();
        setAction(undefined);
        setEnrollment(undefined);
    }

    if (account.isPending) return <output>Loading account settings…</output>;
    if (account.isError)
        return (
            <Card className="space-y-4">
                <h1 className="text-2xl font-semibold">Account settings</h1>
                <ErrorNotice error={account.error} />
                {account.error instanceof IdentityError &&
                account.error.status === 401 ? (
                    <a href={signInPath} className="text-blue-700 underline">
                        Sign in to continue
                    </a>
                ) : (
                    <Button onClick={() => void account.refetch()}>Try again</Button>
                )}
            </Card>
        );
    const data = account.data;
    return (
        <div className="space-y-6">
            <header>
                <h1 className="text-3xl font-semibold tracking-tight">
                    Account settings
                </h1>
                <p className="mt-2 text-base text-slate-600">
                    Manage your Homelab identity, security methods and signed-in devices.
                </p>
            </header>
            <nav
                aria-label="Account sections"
                className="flex flex-wrap gap-5 text-sm font-medium text-blue-800"
            >
                <a href="#account-profile">Account</a>
                <a href="#account-security">Security</a>
                <a href="#account-sessions">Sessions</a>
                <a href="#security-activity">Activity</a>
            </nav>
            {notice && (
                <output className="rounded-lg bg-emerald-50 p-4 text-base text-emerald-900">
                    {notice}
                </output>
            )}
            <Card id="account-profile" className="space-y-5">
                <h2 className="text-xl font-semibold">Account</h2>
                <dl className="grid gap-4 text-base sm:grid-cols-2">
                    <div>
                        <dt className="text-sm text-slate-600">Username</dt>
                        <dd className="mt-1 font-medium">{data.user.username}</dd>
                    </div>
                    <div>
                        <dt className="text-sm text-slate-600">Email</dt>
                        <dd className="mt-1 break-all">{data.user.email}</dd>
                        <dd className="mt-1 text-sm text-slate-600">
                            {data.user.emailVerified ? "Verified" : "Not verified"}
                        </dd>
                    </div>
                </dl>
                <div className="flex flex-wrap gap-3">
                    <Button onClick={() => setAction("email")}>
                        {data.user.emailVerified
                            ? "Change email"
                            : "Verify or change email"}
                    </Button>
                    <Button onClick={() => setAction("password")}>Change password</Button>
                </div>
            </Card>
            <Card id="account-security" className="space-y-5">
                <div>
                    <h2 className="text-xl font-semibold">Security methods</h2>
                    <p className="mt-2 text-base text-slate-600">
                        Use an authenticator app or a security key. Keep a recovery method
                        available before removing your last key.
                    </p>
                </div>
                {data.factors.length === 0 ? (
                    <p className="rounded-lg bg-amber-50 p-3 text-base text-amber-950">
                        Two-factor authentication is not enabled. Add a security method
                        before using protected homelab services.
                    </p>
                ) : (
                    <ul className="divide-y divide-slate-200">
                        {data.factors.map((factor) => (
                            <li
                                key={factor.id}
                                className="flex flex-wrap items-center justify-between gap-3 py-3"
                            >
                                <div>
                                    <p className="font-medium">{factor.label}</p>
                                    <p className="text-sm text-slate-600">
                                        {factor.kind === "totp"
                                            ? "Authenticator app"
                                            : "WebAuthn security key"}
                                        {factor.lastUsedAt
                                            ? ` · Last used ${new Date(factor.lastUsedAt).toLocaleString()}`
                                            : ""}
                                    </p>
                                </div>
                                <Button
                                    onClick={() =>
                                        setAction({
                                            kind: "remove",
                                            id: factor.id,
                                            label: factor.label,
                                        })
                                    }
                                >
                                    Remove
                                </Button>
                            </li>
                        ))}
                    </ul>
                )}
                <div className="flex flex-wrap gap-3">
                    <Button onClick={() => setAction("totp")}>
                        Add authenticator app
                    </Button>
                    <Button onClick={() => setAction("webauthn")}>
                        Add security key
                    </Button>
                </div>
                {data.factors.length > 0 && (
                    <div className="border-t border-slate-200 pt-4">
                        <p className="mb-3 text-base">
                            {data.recoveryCodesRemaining} recovery codes remaining.
                        </p>
                        <Button onClick={() => setAction("recovery")}>
                            Replace recovery codes
                        </Button>
                    </div>
                )}
            </Card>
            <Card id="account-sessions" className="space-y-5">
                <div className="flex flex-wrap items-center justify-between gap-3">
                    <h2 className="text-xl font-semibold">Active sessions</h2>
                    <div className="flex flex-wrap gap-2">
                        <Button
                            disabled={data.sessions.length < 2}
                            onClick={() => setAction("others")}
                        >
                            Revoke other sessions
                        </Button>
                        <Button onClick={() => setAction("all")}>
                            Revoke all sessions
                        </Button>
                    </div>
                </div>
                <p className="text-base text-slate-600">
                    Revoking a session stops its Homelab access. Applications may retain
                    their own local sessions until their next authentication check.
                </p>
                <ul className="divide-y divide-slate-200">
                    {data.sessions.map((session) => (
                        <li
                            key={session.id}
                            className="flex flex-wrap items-start justify-between gap-3 py-4"
                        >
                            <div className="min-w-0 flex-1">
                                <p className="font-medium">
                                    {session.current
                                        ? "Current session"
                                        : "Browser session"}
                                </p>
                                <p className="mt-1 text-sm wrap-break-word text-slate-600">
                                    {session.userAgent}
                                </p>
                                <p className="mt-1 text-sm text-slate-600">
                                    Last active{" "}
                                    {new Date(session.lastSeenAt).toLocaleString()}
                                </p>
                            </div>
                            <Button
                                onClick={() =>
                                    setAction({
                                        kind: "session",
                                        id: session.id,
                                        label: session.current
                                            ? "your current session"
                                            : "this session",
                                    })
                                }
                            >
                                {session.current ? "Log out" : "Revoke"}
                            </Button>
                        </li>
                    ))}
                </ul>
            </Card>
            <Card id="security-activity" className="space-y-4">
                <h2 className="text-xl font-semibold">Security activity</h2>
                <ul className="divide-y divide-slate-200">
                    {data.events.map((event) => (
                        <li
                            key={event.id}
                            className="flex flex-wrap justify-between gap-2 py-2 text-sm"
                        >
                            <span>{event.event.replaceAll("_", " ")}</span>
                            <time className="text-slate-600" dateTime={event.createdAt}>
                                {new Date(event.createdAt).toLocaleString()}
                            </time>
                        </li>
                    ))}
                </ul>
            </Card>
            {action === "password" && (
                <Modal title="Change password" onClose={closeAction}>
                    <p className="mb-4 text-base text-slate-600">
                        Other sessions will be revoked after the change.
                    </p>
                    <FieldsForm
                        fields={[
                            {
                                name: "currentPassword",
                                label: "Current password",
                                type: "password",
                                autoComplete: "current-password",
                                minimum: 8,
                            },
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
                        submitLabel="Change password"
                        onSubmit={async (values) => {
                            await client.action("password", {
                                currentPassword: values.currentPassword,
                                newPassword: values.newPassword,
                            });
                            await refresh("Your password was changed.");
                        }}
                    />
                </Modal>
            )}
            {action === "email" && (
                <Modal title="Verify email" onClose={closeAction}>
                    <p className="mb-4 text-base text-slate-600">
                        Your current address stays active until you confirm the new
                        address using the emailed link.
                    </p>
                    <FieldsForm
                        fields={[
                            {
                                name: "email",
                                label: "Email address",
                                type: "email",
                                autoComplete: "email",
                                initial: data.user.email,
                                maximum: 254,
                            },
                        ]}
                        submitLabel="Send verification email"
                        onSubmit={async (values) => {
                            await client.action("email", { email: values.email });
                            await refresh(
                                "A verification link has been queued for delivery."
                            );
                        }}
                    />
                </Modal>
            )}
            {action === "webauthn" && (
                <Modal title="Add security key" onClose={closeAction}>
                    <FieldsForm
                        fields={[{ name: "label", label: "Key name", maximum: 64 }]}
                        submitLabel="Register security key"
                        onSubmit={async (values) => {
                            const codes = await client.enrollSecurityKey(
                                values.label ?? "Security key"
                            );
                            await refresh("Your security key was registered.");
                            if (codes.length > 0) setRecovery(codes);
                        }}
                    />
                </Modal>
            )}
            {action === "totp" && (
                <Modal title="Add authenticator app" onClose={closeAction}>
                    {enrollment ? (
                        <div className="space-y-4">
                            <p className="text-base">
                                Add this setup key to your authenticator app, then enter
                                the six-digit code.
                            </p>
                            <QRCodeSVG
                                value={enrollment.uri}
                                size={192}
                                title="Scan to add your Homelab authenticator"
                            />
                            <code className="block rounded-lg bg-slate-100 p-3 text-base break-all">
                                {enrollment.secret}
                            </code>
                            <a
                                href={enrollment.uri}
                                className="block text-sm text-blue-700 underline"
                            >
                                Open in an authenticator app
                            </a>
                            <FieldsForm
                                fields={[
                                    {
                                        name: "code",
                                        label: "Six-digit code",
                                        autoComplete: "one-time-code",
                                        minimum: 6,
                                        maximum: 6,
                                    },
                                ]}
                                submitLabel="Verify and enable"
                                onSubmit={async (values) => {
                                    const result = v.parse(
                                        v.object({ recoveryCodes: v.array(v.string()) }),
                                        await client.action("totp/finish", {
                                            token: enrollment.token,
                                            code: values.code,
                                        })
                                    );
                                    await refresh(
                                        "Your authenticator app was registered."
                                    );
                                    if (result.recoveryCodes.length > 0)
                                        setRecovery(result.recoveryCodes);
                                }}
                            />
                        </div>
                    ) : (
                        <FieldsForm
                            fields={[
                                {
                                    name: "label",
                                    label: "Authenticator name",
                                    maximum: 64,
                                },
                            ]}
                            submitLabel="Continue"
                            onSubmit={async (values) => {
                                setEnrollment(
                                    v.parse(
                                        v.object({
                                            token: v.string(),
                                            secret: v.string(),
                                            uri: v.string(),
                                        }),
                                        await client.action("totp/begin", {
                                            label: values.label,
                                        })
                                    )
                                );
                            }}
                        />
                    )}
                </Modal>
            )}
            {action !== undefined &&
                !["password", "email", "webauthn", "totp"].includes(
                    typeof action === "string" ? action : ""
                ) && (
                    <Modal title={confirmationTitle(action)} onClose={closeAction}>
                        <p className="mb-4 text-base text-slate-600">
                            {action === "recovery"
                                ? "Existing recovery codes will stop working. Save the replacement codes immediately."
                                : "This change takes effect immediately."}
                        </p>
                        <FieldsForm
                            fields={[]}
                            submitLabel="Confirm"
                            onSubmit={async () => {
                                if (typeof action === "object") {
                                    await client.action(
                                        action.kind === "remove"
                                            ? "factor/remove"
                                            : "session/revoke",
                                        { id: action.id }
                                    );
                                } else if (action === "recovery") {
                                    const result = v.parse(
                                        v.object({ recoveryCodes: v.array(v.string()) }),
                                        await client.action("recovery/rotate")
                                    );
                                    setRecovery(result.recoveryCodes);
                                } else
                                    await client.action(
                                        action === "all"
                                            ? "sessions/revoke-all"
                                            : "sessions/revoke-others"
                                    );
                                await refresh("The security change was applied.");
                            }}
                        />
                    </Modal>
                )}
            {recovery && (
                <Modal
                    title="Save your recovery codes"
                    onClose={() => setRecovery(undefined)}
                >
                    <p className="mb-4 text-base text-slate-600">
                        Each code works once. Save these privately in your password
                        manager. They cannot be displayed again.
                    </p>
                    <ul className="grid gap-2 rounded-lg bg-slate-100 p-4 font-mono text-sm sm:grid-cols-2">
                        {recovery.map((code) => (
                            <li key={code}>{code}</li>
                        ))}
                    </ul>
                    <Button className="mt-4" onClick={() => setRecovery(undefined)}>
                        I saved the codes
                    </Button>
                </Modal>
            )}
            <SecurityPrompt client={client} />
        </div>
    );
}

function confirmationTitle(action: Action): string {
    if (typeof action === "object")
        return action.kind === "remove"
            ? `Remove ${action.label}?`
            : `Revoke ${action.label}?`;
    if (action === "recovery") return "Replace recovery codes?";
    if (action === "all") return "Revoke all sessions?";
    return "Revoke other sessions?";
}
