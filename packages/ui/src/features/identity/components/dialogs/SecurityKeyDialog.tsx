import { useState } from "react";

import { FieldsForm, Modal } from "../../../../index";
import type { AccountDialogProps } from "../../types";

/**
 * Register a named WebAuthn authenticator through the browser ceremony.
 * @returns The component's rendered content for its current state.
 */
export function SecurityKeyDialog({
    client,
    onClose,
    onComplete,
    onRecoveryCodes,
}: AccountDialogProps & {
    readonly onRecoveryCodes: (codes: readonly string[]) => void;
}) {
    const [pending, setPending] = useState(false);
    return (
        <Modal
            title="Add security key"
            description="Give your key a name, then follow your browser’s instructions to connect or tap it."
            onClose={onClose}
            dismissible={!pending}
        >
            <FieldsForm
                onSubmittingChange={setPending}
                onCancel={onClose}
                fields={[
                    {
                        name: "label",
                        label: "Key name",
                        placeholder: "e.g. Everyday security key",
                        maximum: 64,
                    },
                ]}
                submitLabel="Register security key"
                onSubmit={async (values) => {
                    const codes = await client.enrollSecurityKey(
                        values.label ?? "Security key"
                    );
                    await onComplete("Your security key was registered.");
                    if (codes.length > 0) onRecoveryCodes(codes);
                }}
            />
        </Modal>
    );
}
