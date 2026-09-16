import { useState } from "react";

import { FieldsForm, Modal } from "../../../../index";
import type { AccountDialogProps } from "../../types";

/**
 * Request verification of a replacement email address without changing the active address yet.
 * @returns The component's rendered content for its current state.
 */
export function EmailDialog({
    client,
    onClose,
    onComplete,
    email,
    emailVerified,
}: AccountDialogProps & { readonly email: string; readonly emailVerified: boolean }) {
    const [pending, setPending] = useState(false);
    return (
        <Modal
            title={emailVerified ? "Change email" : "Verify email"}
            description="Your current address stays active until you confirm the new address using the emailed link."
            onClose={onClose}
            dismissible={!pending}
        >
            <FieldsForm
                isSubmitDisabled={(values) =>
                    emailVerified &&
                    values.email?.trim().toLowerCase() === email.toLowerCase()
                }
                onSubmittingChange={setPending}
                onCancel={onClose}
                fields={[
                    {
                        name: "email",
                        placeholder: "you@example.com",
                        label: "Email address",
                        type: "email",
                        autoComplete: "email",
                        initial: email,
                        maximum: 254,
                    },
                ]}
                submitLabel="Send verification email"
                onSubmit={async (values) => {
                    await client.action("email", { email: values.email });
                    await onComplete("Check your inbox for a verification link.");
                }}
            />
        </Modal>
    );
}
