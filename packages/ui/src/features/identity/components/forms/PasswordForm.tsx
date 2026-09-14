import { FieldsForm, type FieldDefinition, type FormValues } from "../../../../index";
import { validatePasswordConfirmation } from "../../validation/password";
const current: FieldDefinition = {
    name: "currentPassword",
    label: "Current password",
    type: "password",
    autoComplete: "current-password",
    minimum: 8,
};
const replacement: readonly FieldDefinition[] = [
    {
        name: "newPassword",
        label: "New password",
        type: "password",
        autoComplete: "new-password",
        minimum: 12,
    },
    {
        name: "confirmPassword",
        label: "Repeat new password",
        type: "password",
        autoComplete: "new-password",
        minimum: 12,
    },
];
export function PasswordForm({
    requireCurrent = false,
    submitLabel,
    onSubmit,
}: {
    requireCurrent?: boolean;
    submitLabel: string;
    onSubmit: (values: FormValues) => Promise<void>;
}) {
    return (
        <FieldsForm
            fields={requireCurrent ? [current, ...replacement] : replacement}
            submitLabel={submitLabel}
            validate={validatePasswordConfirmation}
            onSubmit={onSubmit}
        />
    );
}
