import { useForm } from "@tanstack/react-form";
import { useState } from "react";

import { ErrorNotice } from "../Alert/ErrorNotice";
import { Button } from "../Button/Button";
import { Input } from "../Input/Input";
import { Form } from "./Form";
import { FormField } from "./FormField";
import type { FieldDefinition, FormErrors, FormValues } from "./types";
import { touchedFieldError, validateFields } from "./validation";

export function FieldsForm({
    fields,
    submitLabel,
    onSubmit,
    validate,
}: {
    fields: readonly FieldDefinition[];
    submitLabel: string;
    onSubmit: (values: FormValues) => Promise<void>;
    validate?: (values: FormValues) => FormErrors;
}) {
    const [error, setError] = useState<unknown>();
    const validateValues = ({ value }: { value: FormValues }) =>
        validateFields(fields, value, validate);
    const form = useForm({
        defaultValues: Object.fromEntries(
            fields.map((field) => [field.name, field.initial ?? ""])
        ),
        validators: { onChange: validateValues },
        onSubmit: async ({ value }) => {
            setError(undefined);
            try {
                await onSubmit(value);
                form.reset();
            } catch (error) {
                setError(error);
            }
        },
    });
    return (
        <form.Subscribe
            selector={(state) => [state.canSubmit, state.isSubmitting] as const}
        >
            {([canSubmit, submitting]) => (
                <Form onSubmit={() => form.handleSubmit()} className="space-y-4">
                    {fields.map((definition) => (
                        <form.Field name={definition.name} key={definition.name}>
                            {(field) => (
                                <FormField
                                    label={definition.label}
                                    error={touchedFieldError(field.state.meta)}
                                    disabled={submitting}
                                >
                                    <Input
                                        name={definition.name}
                                        type={definition.type ?? "text"}
                                        autoComplete={definition.autoComplete}
                                        placeholder={definition.placeholder}
                                        value={field.state.value ?? ""}
                                        onBlur={() => {
                                            field.handleBlur();
                                            // Reuse change validation so corrected errors cannot linger.
                                            void field.validate("change");
                                        }}
                                        onChange={(event) => {
                                            setError(undefined);
                                            field.handleChange(event.target.value);
                                        }}
                                        required
                                        minLength={definition.minimum ?? 1}
                                        maxLength={definition.maximum ?? 256}
                                    />
                                </FormField>
                            )}
                        </form.Field>
                    ))}
                    {error !== undefined && <ErrorNotice error={error} />}
                    <Button
                        type="submit"
                        busy={submitting}
                        disabled={!canSubmit}
                        fullWidth
                    >
                        {submitLabel}
                    </Button>
                </Form>
            )}
        </form.Subscribe>
    );
}
