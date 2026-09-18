import { passwordPolicy } from "@homelab/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";

import { Button, ErrorNotice, FieldsForm, LoadingState } from "../../../../index";
import type { IdentityClient } from "../../api/IdentityClient";

/**
 * Offer the current account's available step-up methods and report successful proof.
 * @returns The component's rendered content for its current state.
 */
export function VerificationMethods({
    client,
    onVerified,
    renderFrame,
}: {
    client: IdentityClient;
    onVerified: () => void;
    renderFrame?: (content: ReactNode, description: string) => ReactNode;
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
    function frame(
        content: ReactNode,
        description = "Choose a verification method to finish signing in."
    ): ReactNode {
        return renderFrame ? renderFrame(content, description) : content;
    }
    if (methods.isPending)
        return frame(<LoadingState label="Loading verification methods…" size="sm" />);
    if (methods.isError)
        return frame(
            <div className="space-y-3">
                <ErrorNotice error={methods.error} />
                <Button fullWidth onClick={() => void methods.refetch()}>
                    Try again
                </Button>
            </div>
        );
    const available = methods.data.methods;
    if (available.length === 0)
        return frame(
            <FieldsForm
                fields={[
                    {
                        name: "password",
                        label: "Current password",
                        placeholder: "Enter your current password",
                        type: "password",
                        autoComplete: "current-password",
                        minimum: passwordPolicy.minimumLength,
                    },
                ]}
                submitLabel="Verify password"
                onSubmit={async (value) => {
                    await client.request("/api/account/proof/password", {
                        password: value.password,
                    });
                    onVerified();
                }}
            />,
            "Enter your password to verify your identity."
        );
    if (codeMethod && (codeMethod !== "recovery" || methods.data.recoveryAvailable))
        return frame(
            <FieldsForm
                key={codeMethod}
                onCancel={() => setCodeMethod(undefined)}
                cancelLabel="Use another method"
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
            />,
            codeMethod === "totp"
                ? "Enter a 6-digit code from your authenticator app."
                : "Enter one of your unused recovery codes."
        );
    return frame(
        <div className="grid grid-cols-1 gap-3">
            {error !== undefined && <ErrorNotice error={error} />}
            {available.includes("webauthn") && (
                <Button
                    fullWidth
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
                <Button
                    fullWidth
                    variant={available.includes("webauthn") ? "secondary" : "primary"}
                    disabled={busy}
                    onClick={() => setCodeMethod("totp")}
                >
                    Use authenticator app
                </Button>
            )}
            {methods.data.recoveryAvailable && (
                <Button
                    fullWidth
                    variant="ghost"
                    disabled={busy}
                    onClick={() => setCodeMethod("recovery")}
                >
                    Use recovery code
                </Button>
            )}
        </div>
    );
}
