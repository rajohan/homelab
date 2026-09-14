import { Field, Input, Label } from "@headlessui/react";

import type { FieldDefinition } from "./types";

export function FormField({
    definition,
    value,
    onBlur,
    onChange,
}: {
    definition: FieldDefinition;
    value: string;
    onBlur: () => void;
    onChange: (value: string) => void;
}) {
    return (
        <Field>
            <Label className="mb-1.5 block text-sm font-medium">{definition.label}</Label>
            <Input
                name={definition.name}
                type={definition.type ?? "text"}
                autoComplete={definition.autoComplete}
                value={value}
                onBlur={onBlur}
                onChange={(event) => onChange(event.target.value)}
                required
                minLength={definition.minimum ?? 1}
                maxLength={definition.maximum ?? 256}
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-base focus:border-blue-600"
            />
        </Field>
    );
}
