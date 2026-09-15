import type { FormErrors, FormValues } from "../../../components/Form/types";

/**
 * Check that the two proposed password fields agree.
 * @param values - The current form values.
 * @returns A confirmation-field error, or an empty map when they agree.
 */
export function validatePasswordConfirmation(values: FormValues): FormErrors {
    return values.newPassword === values.confirmPassword
        ? {}
        : { confirmPassword: "The new passwords do not match." };
}
