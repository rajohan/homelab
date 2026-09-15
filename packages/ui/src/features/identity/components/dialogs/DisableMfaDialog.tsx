import { useState } from "react";

import { FieldsForm, Modal } from "../../../../index";
import type { AccountDialogProps } from "../../types";

/**
 * Confirm removal with the current password and the shared fresh-proof retry flow.
 * @returns A guarded dialog which cannot dismiss an in-flight destructive action.
 */
export function DisableMfaDialog({ client, onClose, onComplete }: AccountDialogProps) {
    const [pending, setPending] = useState(false);
    return (
        <Modal
            title="Disable two-step login?"
            description="All security keys, authenticator apps and recovery codes will be removed. All sessions will be signed out."
            onClose={onClose}
            dismissible={!pending}
        >
            <FieldsForm
                onCancel={onClose}
                fields={[
                    {
                        name: "password",
                        label: "Current password",
                        type: "password",
                        autoComplete: "current-password",
                        placeholder: "Enter your current password",
                        minimum: 8,
                    },
                ]}
                submitLabel="Disable two-step login"
                submitVariant="danger"
                onSubmit={async (values) => {
                    setPending(true);
                    try {
                        await client.action("mfa/disable", { password: values.password });
                        await onComplete(
                            "Two-step login was disabled. All sessions were signed out."
                        );
                    } finally {
                        setPending(false);
                    }
                }}
            />
        </Modal>
    );
}
