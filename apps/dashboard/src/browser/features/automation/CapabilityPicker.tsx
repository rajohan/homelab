import {
    capabilities,
    capabilityDetails,
    type Capability,
} from "@homelab/contracts/operations";
import { Button, Fieldset, Switch } from "@homelab/ui";

const groups = [
    ...new Set(capabilities.map((capability) => capabilityDetails[capability].group)),
];

/**
 * Select precise, server-enforced API permissions without implicitly granting dependencies.
 * @returns Grouped permission switches with descriptions and explicit bulk selection.
 */
export function CapabilityPicker({
    value,
    onChange,
}: {
    readonly value: readonly Capability[];
    readonly onChange: (value: Capability[]) => void;
}) {
    return (
        <Fieldset legend="Permissions" className="space-y-4">
            <div className="flex flex-wrap gap-2">
                <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => onChange([...capabilities])}
                >
                    Select all
                </Button>
                <Button size="sm" variant="secondary" onClick={() => onChange([])}>
                    Clear selection
                </Button>
            </div>
            {groups.map((group) => (
                <div
                    key={group}
                    className="space-y-3 rounded-lg border border-primary-700 bg-primary-900/40 p-3"
                >
                    <h4 className="text-sm font-semibold">{group}</h4>
                    {capabilities
                        .filter(
                            (capability) => capabilityDetails[capability].group === group
                        )
                        .map((capability) => (
                            <Switch
                                key={capability}
                                label={capabilityDetails[capability].label}
                                description={capabilityDetails[capability].description}
                                checked={value.includes(capability)}
                                onChange={(checked) =>
                                    onChange(
                                        checked
                                            ? [...value, capability]
                                            : value.filter(
                                                  (entry) => entry !== capability
                                              )
                                    )
                                }
                            />
                        ))}
                </div>
            ))}
        </Fieldset>
    );
}
