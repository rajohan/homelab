import { useForm } from "@tanstack/react-form";
import { useState } from "react";

import { ErrorNotice } from "../Alert/ErrorNotice";
import { Button } from "../Button/Button";
import { FormField } from "./FormField";
import type { FieldDefinition, FormValues } from "./types";

export function FieldsForm({
    fields,
    submitLabel,
    onSubmit,
    validate,
}: {
    fields: readonly FieldDefinition[];
    submitLabel: string;
    onSubmit: (values: FormValues) => Promise<void>;
    validate?: (values: FormValues) => string | undefined;
}) {
    const [error, setError] = useState<unknown>();
    const form = useForm({
        defaultValues: Object.fromEntries(
            fields.map((field) => [field.name, field.initial ?? ""])
        ),
        onSubmit: async ({ value }) => {
            setError(undefined);
            const invalid = validate?.(value);
            if (invalid) {
                setError(new Error(invalid));
                return;
            }
            try {
                await onSubmit(value);
                form.reset();
            } catch (error) {
                setError(error);
            }
        },
    });
    return (
        <form
            onSubmit={(event) => {
                event.preventDefault();
                void form.handleSubmit();
            }}
            className="space-y-4"
        >
            {fields.map((definition) => (
                <form.Field name={definition.name} key={definition.name}>
                    {(field) => (
                        <FormField
                            definition={definition}
                            value={field.state.value ?? ""}
                            onBlur={field.handleBlur}
                            onChange={field.handleChange}
                        />
                    )}
                </form.Field>
            ))}
            {error !== undefined && <ErrorNotice error={error} />}
            <form.Subscribe selector={(state) => state.isSubmitting}>
                {(submitting) => (
                    <Button type="submit" disabled={submitting}>
                        {submitting ? "Please wait…" : submitLabel}
                    </Button>
                )}
            </form.Subscribe>
        </form>
    );
}
