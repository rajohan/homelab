import { Button } from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useState, useSyncExternalStore } from "react";

import type { IdentityClient } from "./client";
import { ErrorNotice, FieldsForm, Modal } from "./controls";

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
    if (codeMethod)
        return (
            <div className="space-y-3">
                <FieldsForm
                    fields={[
                        {
                            name: "code",
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
            <Button disabled={busy} onClick={() => setCodeMethod("recovery")}>
                Use recovery code
            </Button>
        </div>
    );
}

export function SecurityPrompt({ client }: { client: IdentityClient }) {
    useEffect(() => () => client.cancelActions(), [client]);
    const open = useSyncExternalStore(
        client.verification.subscribe,
        client.verification.getSnapshot,
        client.verification.getSnapshot
    );
    if (!open) return null;
    return (
        <Modal title="Confirm your identity" onClose={() => client.verification.cancel()}>
            <p className="mb-4 text-base text-slate-600">
                Verify again to continue. Your pending action will resume automatically.
            </p>
            <VerificationMethods
                key={open}
                client={client}
                onVerified={() => client.verification.complete(open)}
            />
        </Modal>
    );
}
