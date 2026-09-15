import type { FormErrors, FormValues } from "../../../components/Form/types";

export function validatePasswordConfirmation(values: FormValues): FormErrors {
    return values.newPassword === values.confirmPassword
        ? {}
        : { confirmPassword: "The new passwords do not match." };
}
