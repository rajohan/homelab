import { FormField, Select } from "@homelab/ui";

/**
 * Share the explicit code-work location across web and desktop settings and reviews.
 * @returns Controlled target choice; changing it never moves an already approved job.
 */
export function CodeTargetSettings({
    value,
    onChange,
    disabled = false,
    inherit = false,
}: {
    readonly value: "main" | "daytona" | undefined;
    readonly onChange: (value: "main" | "daytona" | undefined) => void;
    readonly disabled?: boolean;
    readonly inherit?: boolean;
}) {
    return (
        <FormField
            label="Code execution"
            description="Main runs Homelab checks locally. Daytona uses a cloud sandbox."
        >
            <Select
                label="Code execution"
                value={value ?? (inherit ? "" : "daytona")}
                disabled={disabled}
                options={[
                    ...(inherit
                        ? [{ value: "", label: "Use conversation setting" }]
                        : []),
                    { value: "main", label: "Main · local" },
                    { value: "daytona", label: "Daytona · cloud" },
                ]}
                onChange={(next) =>
                    onChange(next === "main" || next === "daytona" ? next : undefined)
                }
            />
        </FormField>
    );
}
