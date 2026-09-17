import { PageHeader } from "@homelab/ui";

import { InfrastructureSummary } from "../features/operations/InfrastructureSummary";

/**
 * Show the read-only infrastructure integration without coupling it to authentication.
 * @returns The latest worker-owned monitoring snapshot.
 */
export function Infrastructure() {
    return (
        <>
            <PageHeader
                title="Infrastructure"
                description="Read-only monitoring data, collected independently of your browser."
            />
            <InfrastructureSummary />
        </>
    );
}
