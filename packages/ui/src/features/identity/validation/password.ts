import type { FormValues } from "../../../components/Form/types";
export function validatePasswordConfirmation(values: FormValues): string | undefined {
    return values.newPassword === values.confirmPassword
        ? undefined
        : "The new passwords do not match.";
}
