import { Fieldset } from "@headlessui/react";
import { useForm } from "@tanstack/react-form";
import { useState, type ReactNode } from "react";

import { ErrorNotice } from "../Alert/ErrorNotice";
import { ActionGroup } from "../Button/ActionGroup";
import { Button } from "../Button/Button";
import { Input } from "../Input/Input";
import { Form } from "./Form";
import { FormField } from "./FormField";
import type { FieldDefinition, FormErrors, FormValues } from "./types";
import { touchedFieldError, validateFields } from "./validation";

/**
 * Render declarative fields with live validation and action-local submission feedback.
 * @returns The component's rendered content for its current state.
 */
export function FieldsForm({
    fields,
    children,
    submitLabel,
    submitVariant = "primary",
    onSubmit,
    onSubmittingChange,
    validate,
    isSubmitDisabled,
    onCancel,
    cancelLabel = "Cancel",
}: {
    fields: readonly FieldDefinition[];
    children?: ReactNode;
    submitLabel: string;
    submitVariant?: "primary" | "danger";
    onSubmit: (values: FormValues) => Promise<void>;
    onSubmittingChange?: ((pending: boolean) => void) | undefined;
    validate?: (values: FormValues) => FormErrors;
    isSubmitDisabled?: (values: FormValues) => boolean;
    onCancel?: (() => void) | undefined;
    cancelLabel?: string;
}) {
    const [error, setError] = useState<unknown>();
    const validateValues = ({ value }: { value: FormValues }) =>
        validateFields(fields, value, validate);
    const form = useForm({
        defaultValues: Object.fromEntries(
            fields.map((field) => [field.name, field.initial ?? ""])
        ),
        validators: {
            // Before submit, focus/blur from password-manager controls is not an edit.
            // After any submit attempt, keep validating every field until form.reset().
            // These local rules are synchronous: do not clear submit errors while
            // waiting for a debounced change validator to replace them.
            onChange: ({ value, formApi }) =>
                validateFields(
                    fields,
                    value,
                    validate,
                    formApi.state.submissionAttempts > 0
                        ? undefined
                        : new Set(
                              fields
                                  .filter(
                                      (field) => formApi.getFieldMeta(field.name)?.isDirty
                                  )
                                  .map((field) => field.name)
                          )
                ),
            onSubmit: validateValues,
        },
        onSubmit: async ({ value }) => {
            if (isSubmitDisabled?.(value)) return;
            setError(undefined);
            onSubmittingChange?.(true);
            try {
                await onSubmit(value);
                form.reset();
            } catch (error) {
                setError(error);
            } finally {
                onSubmittingChange?.(false);
            }
        },
    });
    return (
        <form.Subscribe
            selector={(state) =>
                [state.canSubmit, state.isSubmitting, state.values] as const
            }
        >
            {([canSubmit, submitting, values]) => (
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
                                        onBlur={(event) => {
                                            if (
                                                event.currentTarget.value !==
                                                field.state.value
                                            )
                                                field.handleChange(
                                                    event.currentTarget.value
                                                );
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
                    {children && <Fieldset disabled={submitting}>{children}</Fieldset>}
                    {error !== undefined && <ErrorNotice error={error} />}
                    <ActionGroup>
                        <Button
                            type="submit"
                            variant={submitVariant}
                            busy={submitting}
                            disabled={!canSubmit || isSubmitDisabled?.(values)}
                            fullWidth={onCancel === undefined}
                        >
                            {submitLabel}
                        </Button>
                        {onCancel && (
                            <Button
                                variant="secondary"
                                disabled={submitting}
                                onClick={onCancel}
                            >
                                {cancelLabel}
                            </Button>
                        )}
                    </ActionGroup>
                </Form>
            )}
        </form.Subscribe>
    );
}
