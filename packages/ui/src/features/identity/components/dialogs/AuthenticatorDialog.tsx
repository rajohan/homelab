import { QRCodeSVG } from "qrcode.react";
import { useState } from "react";
import * as v from "valibot";

import { CopyTextButton, FieldsForm, Modal } from "../../../../index";
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
    const [pending, setPending] = useState(false);
    return (
        <Modal
            title="Add authenticator app"
            description={
                enrollment
                    ? "Scan the QR code, or enter the setup key manually, then confirm with a code from your authenticator app."
                    : "Give this authenticator a name so you can recognize it later."
            }
            onClose={onClose}
            dismissible={!pending}
        >
            {enrollment ? (
                <div className="space-y-4">
                    <div className="flex justify-center">
                        <div className="rounded-lg bg-white p-3">
                            <QRCodeSVG
                                value={enrollment.uri}
                                size={192}
                                marginSize={4}
                                className="h-auto max-w-full"
                                title="Authenticator enrollment QR code"
                            />
                        </div>
                    </div>
                    <div className="min-w-0">
                        <p className="text-sm font-medium text-primary-200">
                            Manual setup key
                        </p>
                        <div className="mt-2 flex min-w-0 items-center gap-2 rounded-lg border border-primary-700 bg-primary-900 p-2">
                            <code className="min-w-0 flex-1 p-1 font-mono text-xs break-all text-primary-100 select-all">
                                {enrollment.secret}
                            </code>
                            <CopyTextButton
                                iconOnly
                                label="Copy setup key"
                                text={enrollment.secret}
                            />
                        </div>
                    </div>
                    <FieldsForm
                        onSubmittingChange={setPending}
                        onCancel={onClose}
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
                    onSubmittingChange={setPending}
                    onCancel={onClose}
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
