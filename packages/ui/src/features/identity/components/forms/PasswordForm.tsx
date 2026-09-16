import { passwordPolicy } from "@homelab/contracts";

import { FieldsForm, type FieldDefinition, type FormValues } from "../../../../index";
import { validatePasswordConfirmation } from "../../validation/password";
const current: FieldDefinition = {
    name: "currentPassword",
    label: "Current password",
    placeholder: "Enter your current password",
    type: "password",
    autoComplete: "current-password",
    minimum: passwordPolicy.minimumLength,
};
const replacement: readonly FieldDefinition[] = [
    {
        name: "newPassword",
        label: "New password",
        placeholder: `At least ${passwordPolicy.minimumLength} characters`,
        type: "password",
        autoComplete: "new-password",
        minimum: passwordPolicy.minimumLength,
    },
    {
        name: "confirmPassword",
        label: "Repeat new password",
        placeholder: "Re-enter your new password",
        type: "password",
        autoComplete: "new-password",
        minimum: passwordPolicy.minimumLength,
    },
];
/**
 * Collect and validate password fields, including confirmation, before submission.
 * @returns The component's rendered content for its current state.
 */
export function PasswordForm({
    requireCurrent = false,
    submitLabel,
    onSubmit,
    onSubmittingChange,
    onCancel,
}: {
    requireCurrent?: boolean;
    submitLabel: string;
    onCancel?: () => void;
    onSubmit: (values: FormValues) => Promise<void>;
    onSubmittingChange?: ((pending: boolean) => void) | undefined;
}) {
    return (
        <FieldsForm
            fields={requireCurrent ? [current, ...replacement] : replacement}
            submitLabel={submitLabel}
            validate={validatePasswordConfirmation}
            onSubmit={onSubmit}
            onSubmittingChange={onSubmittingChange}
            onCancel={onCancel}
        />
    );
}
