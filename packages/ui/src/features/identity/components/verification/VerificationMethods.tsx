import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { Button, ErrorNotice, FieldsForm } from "../../../../index";
import type { IdentityClient } from "../../api/IdentityClient";

export function VerificationMethods({
    client,
    onVerified,
}: {
    client: IdentityClient;
    onVerified: () => void;
}) {
    const methods = useQuery({
        queryKey: ["identity", "methods"],
        queryFn: () => client.session(),
        staleTime: 0,
        retry: false,
    });
    const [codeMethod, setCodeMethod] = useState<"totp" | "recovery" | undefined>();
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<unknown>();
    if (methods.isPending) return <output>Loading verification methods…</output>;
    if (methods.isError)
        return (
            <div className="space-y-3">
                <ErrorNotice error={methods.error} />
                <Button onClick={() => void methods.refetch()}>Try again</Button>
            </div>
        );
    const available = methods.data.methods;
    if (available.length === 0)
        return (
            <FieldsForm
                fields={[
                    {
                        name: "password",
                        label: "Current password",
                        placeholder: "Enter your current password",
                        type: "password",
                        autoComplete: "current-password",
                        minimum: 8,
                    },
                ]}
                submitLabel="Verify password"
                onSubmit={async (value) => {
                    await client.request("/api/account/proof/password", {
                        password: value.password,
                    });
                    onVerified();
                }}
            />
        );
    if (codeMethod && (codeMethod !== "recovery" || methods.data.recoveryAvailable))
        return (
            <div className="space-y-3">
                <FieldsForm
                    fields={[
                        {
                            name: "code",
                            minimum: codeMethod === "totp" ? 6 : 1,
                            validate: (value) =>
                                codeMethod === "totp" && !/^\d{6}$/.test(value)
                                    ? "Enter a 6-digit code."
                                    : undefined,
                            placeholder:
                                codeMethod === "totp"
                                    ? "6-digit code"
                                    : "Enter a recovery code",
                            label:
                                codeMethod === "totp"
                                    ? "Authenticator code"
                                    : "Recovery code",
                            autoComplete: "one-time-code",
                            maximum: codeMethod === "totp" ? 6 : 64,
                        },
                    ]}
                    submitLabel="Verify"
                    onSubmit={async (value) => {
                        await client.request(`/api/account/proof/${codeMethod}`, {
                            code: value.code?.trim(),
                        });
                        onVerified();
                    }}
                />
                <Button onClick={() => setCodeMethod(undefined)}>
                    Use another method
                </Button>
            </div>
        );
    return (
        <div className="space-y-3">
            {error !== undefined && <ErrorNotice error={error} />}
            {available.includes("webauthn") && (
                <Button
                    disabled={busy}
                    onClick={() => {
                        setBusy(true);
                        setError(undefined);
                        void client
                            .securityKeyProof()
                            .then(onVerified)
                            .catch(setError)
                            .finally(() => setBusy(false));
                    }}
                >
                    {busy ? "Waiting for your security key…" : "Use security key"}
                </Button>
            )}
            {available.includes("totp") && (
                <Button disabled={busy} onClick={() => setCodeMethod("totp")}>
                    Use authenticator app
                </Button>
            )}
            {methods.data.recoveryAvailable && (
                <Button disabled={busy} onClick={() => setCodeMethod("recovery")}>
                    Use recovery code
                </Button>
            )}
        </div>
    );
}
