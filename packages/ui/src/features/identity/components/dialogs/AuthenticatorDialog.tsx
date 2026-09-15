import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";
import * as v from "valibot";

import { FieldsForm, Modal } from "../../../../index";
import type { AccountDialogProps } from "../../types";

/**
 * Enroll a TOTP authenticator and present newly issued recovery codes.
 * @returns The component's rendered content for its current state.
 */
export function AuthenticatorDialog({
    client,
    onClose,
    onComplete,
    onRecoveryCodes,
}: AccountDialogProps & {
    readonly onRecoveryCodes: (codes: readonly string[]) => void;
}) {
    const [enrollment, setEnrollment] = useState<{
        token: string;
        secret: string;
        uri: string;
    }>();
    return (
        <Modal
            title="Add authenticator app"
            description="Use an authenticator app to generate a new six-digit sign-in code every 30 seconds."
            onClose={onClose}
        >
            {enrollment ? (
                <div className="space-y-4">
                    <p className="text-base">
                        Scan the QR code or enter the setup key in your app, then enter
                        the six-digit code.
                    </p>
                    <QRCodeSVG
                        value={enrollment.uri}
                        size={192}
                        marginSize={4}
                        className="h-auto max-w-full"
                        title="Scan to add your Homelab authenticator"
                    />
                    <code className="block rounded-lg bg-primary-900 p-3 text-base break-all">
                        {enrollment.secret}
                    </code>
                    <a
                        href={enrollment.uri}
                        className="block text-sm text-accent-300 underline"
                    >
                        Open in an authenticator app
                    </a>
                    <FieldsForm
                        fields={[
                            {
                                name: "code",
                                validate: (value) =>
                                    /^\d{6}$/.test(value)
                                        ? undefined
                                        : "Enter a 6-digit code.",
                                placeholder: "6-digit code",
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
                            await onComplete("Your authenticator app was registered.");
                            if (result.recoveryCodes.length > 0)
                                onRecoveryCodes(result.recoveryCodes);
                        }}
                    />
                </div>
            ) : (
                <FieldsForm
                    fields={[
                        {
                            name: "label",
                            label: "Authenticator name",
                            placeholder: "e.g. Personal phone",
                            maximum: 64,
                        },
                    ]}
                    submitLabel="Set up authenticator"
                    onSubmit={async (values) => {
                        setEnrollment(
                            v.parse(
                                v.object({
                                    token: v.string(),
                                    secret: v.string(),
                                    uri: v.string(),
                                }),
                                await client.action("totp/begin", { label: values.label })
                            )
                        );
                    }}
                />
            )}
        </Modal>
    );
}
