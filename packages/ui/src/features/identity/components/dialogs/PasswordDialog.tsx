import { Modal } from "../../../../index";
import type { AccountDialogProps } from "../../types";
import { PasswordForm } from "../forms/PasswordForm";
/**
 * Change the account password through the shared authenticated action flow.
 * @returns The component's rendered content for its current state.
 */
export function PasswordDialog({ client, onClose, onComplete }: AccountDialogProps) {
    return (
        <Modal title="Change password" onClose={onClose}>
            <p className="mb-4 text-base text-primary-300">
                Other sessions will be revoked after the change.
            </p>
            <PasswordForm
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
