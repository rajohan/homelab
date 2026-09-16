import { useState } from "react";

import { Modal } from "../../../../index";
import type { AccountDialogProps } from "../../types";
import { PasswordForm } from "../forms/PasswordForm";
/**
 * Change the account password through the shared authenticated action flow.
 * @returns The component's rendered content for its current state.
 */
export function PasswordDialog({ client, onClose, onComplete }: AccountDialogProps) {
    const [pending, setPending] = useState(false);
    return (
        <Modal
            title="Change password"
            description="This browser stays signed in. Your other sessions will be signed out after you change your password."
            onClose={onClose}
            dismissible={!pending}
        >
            <PasswordForm
                onSubmittingChange={setPending}
                onCancel={onClose}
                requireCurrent
                submitLabel="Change password"
                onSubmit={async (values) => {
                    await client.action("password", {
                        currentPassword: values.currentPassword,
                        newPassword: values.newPassword,
                    });
                    await onComplete("Your password was changed.");
                }}
            />
        </Modal>
    );
}
