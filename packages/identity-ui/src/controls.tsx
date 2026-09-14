import {
    Dialog,
    DialogBackdrop,
    DialogPanel,
    DialogTitle,
    Field,
    Input,
    Label,
} from "@headlessui/react";
import { Button } from "@homelab/ui";
import { useForm } from "@tanstack/react-form";
import { useState, type ReactNode } from "react";

export function Modal({
    title,
    children,
    onClose,
}: {
    title: string;
    children: ReactNode;
    onClose: () => void;
}) {
    return (
        <Dialog open onClose={onClose} className="relative z-50">
            <DialogBackdrop className="fixed inset-0 bg-slate-950/40 backdrop-blur-xs" />
            <div className="fixed inset-0 overflow-y-auto p-4 sm:p-8">
                <div className="flex min-h-full items-center justify-center">
                    <DialogPanel className="w-full max-w-lg rounded-xl bg-white p-6 text-base text-slate-900 shadow-xl">
                        <div className="mb-5 flex items-center justify-between gap-4">
                            <DialogTitle className="text-xl font-semibold">
                                {title}
                            </DialogTitle>
                            <Button onClick={onClose} aria-label="Close dialog">
                                Close
                            </Button>
                        </div>
                        {children}
                    </DialogPanel>
                </div>
            </div>
        </Dialog>
    );
}

export interface FormField {
    readonly name: string;
    readonly label: string;
    readonly type?: "email" | "password" | "text";
    readonly autoComplete?: string;
    readonly minimum?: number;
    readonly maximum?: number;
    readonly initial?: string;
}

export function FieldsForm({
    fields,
    submitLabel,
    onSubmit,
}: {
    fields: readonly FormField[];
    submitLabel: string;
    onSubmit: (values: Readonly<Record<string, string>>) => Promise<void>;
}) {
    const [error, setError] = useState("");
    const form = useForm({
        defaultValues: Object.fromEntries(
            fields.map((field) => [field.name, field.initial ?? ""])
        ),
        onSubmit: async ({ value }) => {
            setError("");
            try {
                if (
                    value.confirmPassword !== undefined &&
                    value.newPassword !== value.confirmPassword
                ) {
                    setError("The new passwords do not match.");
                    return;
                }
                await onSubmit(value);
                form.reset();
            } catch (error) {
                setError(error instanceof Error ? error.message : "The request failed.");
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
            {fields.map((specification) => (
                <form.Field name={specification.name} key={specification.name}>
                    {(field) => (
                        <Field>
                            <Label className="mb-1.5 block text-sm font-medium">
                                {specification.label}
                            </Label>
                            <Input
                                name={field.name}
                                type={specification.type ?? "text"}
                                autoComplete={specification.autoComplete}
                                value={field.state.value ?? ""}
                                onBlur={field.handleBlur}
                                onChange={(event) =>
                                    field.handleChange(event.target.value)
                                }
                                required
                                minLength={specification.minimum ?? 1}
                                maxLength={specification.maximum ?? 256}
                                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-base focus:border-blue-600"
                            />
                        </Field>
                    )}
                </form.Field>
            ))}
            {error && (
                <p role="alert" className="text-sm text-red-700">
                    {error}
                </p>
            )}
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

export function ErrorNotice({ error }: { error: unknown }) {
    return (
        <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">
            {error instanceof Error ? error.message : "The request failed."}
        </p>
    );
}
