import { Button, Fieldset } from "@homelab/ui";

const lifetimes = [
    { days: 30, label: "30 days" },
    { days: 90, label: "90 days" },
    { days: 365, label: "1 year" },
    { days: null, label: "No expiry" },
] as const;

/**
 * Select an explicit lifetime for a new automation credential.
 * @returns Accessible preset controls reused for creation and staged rotation.
 */
export function TokenLifetime({
    value,
    onChange,
}: {
    readonly value: number | null;
    readonly onChange: (days: number | null) => void;
}) {
    return (
        <Fieldset legend="Token lifetime">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {lifetimes.map((lifetime) => (
                    <Button
                        key={lifetime.label}
                        size="sm"
                        variant={value === lifetime.days ? "primary" : "secondary"}
                        aria-pressed={value === lifetime.days}
                        onClick={() => onChange(lifetime.days)}
                    >
                        {lifetime.label}
                    </Button>
                ))}
            </div>
        </Fieldset>
    );
}
