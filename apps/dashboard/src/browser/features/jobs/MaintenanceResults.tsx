import type { MaintenanceResult } from "@homelab/contracts/maintenance";

/**
 * Present verified per-target receipts, including partial success in a failed host batch.
 * @param props - Safe results committed under the live job lease.
 * @returns Version, health, remaining restart requirements and recorded warnings.
 */
export function MaintenanceResults({
    results,
}: {
    readonly results: readonly MaintenanceResult[];
}) {
    if (results.length === 0) return null;
    return (
        <section className="space-y-3" aria-label="Maintenance results">
            <h3 className="font-medium">Verified results</h3>
            <p className="text-sm text-primary-400">
                These entries completed verification. A failed or cancelled run may have
                additional, unverified changes; inspect its last progress before retrying.
            </p>
            {results.map((result, index) => (
                <div
                    key={`${index}:${result.label}`}
                    className="space-y-1 rounded-lg border border-primary-700 bg-primary-950/40 p-3 text-sm"
                >
                    <p className="font-medium">{result.label}</p>
                    {result.installed && (
                        <p className="wrap-anywhere">Installed: {result.installed}</p>
                    )}
                    <p>Health: {healthLabels[result.health]}</p>
                    <p>Host restart: {restartLabel(result.rebootRequired)}</p>
                    {result.warnings.map((warning) => (
                        <p key={warning} className="text-primary-300">
                            {warning}
                        </p>
                    ))}
                </div>
            ))}
        </section>
    );
}

const healthLabels = {
    passed: "Passed",
    "preserved-stopped": "Previously stopped; left stopped",
    "not-checked": "Not checked",
};
function restartLabel(required: boolean | null): string {
    if (required === null) return "Unknown";
    return required ? "Still required" : "Not required";
}
