import * as v from "valibot";

import type { FieldDefinition, FormErrors, FormValues } from "./types";

/**
 * Runs the same rules during editing, on blur and at submission.
 * @param definitions Field constraints and presentation metadata.
 * @param values Current form values.
 * @param validate Optional cross-field rules.
 * @returns Field-addressed errors, or undefined when valid.
 */
export function validateFields(
    definitions: readonly FieldDefinition[],
    values: FormValues,
    validate?: (values: FormValues) => FormErrors
): { fields: Record<string, string> } | undefined {
    const fields: Record<string, string> = {};
    for (const definition of definitions) {
        const value = values[definition.name] ?? "";
        if (!value || (definition.type !== "password" && !value.trim())) {
            fields[definition.name] = `${definition.label} is required.`;
            continue;
        }
        const result = v.safeParse(
            v.pipe(
                v.string(),
                v.minLength(
                    definition.minimum ?? 1,
                    `${definition.label} must contain at least ${definition.minimum ?? 1} characters.`
                ),
                v.maxLength(
                    definition.maximum ?? 256,
                    `${definition.label} must contain at most ${definition.maximum ?? 256} characters.`
                )
            ),
            value
        );
        const message =
            result.issues?.[0]?.message ??
            (definition.type === "email" && !v.is(v.pipe(v.string(), v.email()), value)
                ? "Enter a valid email address."
                : definition.validate?.(value));
        if (message) fields[definition.name] = message;
    }
    for (const [name, message] of Object.entries(validate?.(values) ?? {})) {
        if (message && !fields[name]) fields[name] = message;
    }
    return Object.keys(fields).length > 0 ? { fields } : undefined;
}

/**
 * Avoids errors on untouched fields until submit validation runs.
 * @param metadata TanStack field interaction and validation state.
 * @returns The first error that should be shown beside the field.
 */
export function touchedFieldError(metadata: {
    readonly errors: readonly unknown[];
    readonly isTouched: boolean;
}): string | undefined {
    const errors = metadata.isTouched ? metadata.errors : [];
    return errors.find(
        (error): error is string => typeof error === "string" && error.length > 0
    );
}
