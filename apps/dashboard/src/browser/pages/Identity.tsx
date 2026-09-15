import { Badge, Card, PageHeader } from "@homelab/ui";

/**
 * Explain the independent identity service and the current preview boundaries.
 * @returns The component's rendered content for its current state.
 */
export function Identity() {
    return (
        <>
            <PageHeader
                eyebrow="Identity"
                title="One identity. Clear boundaries."
                description="A separate identity application serves the dashboard and other approved clients."
            />
            <Card aria-labelledby="identity-heading">
                <div className="mb-4.5 flex items-start justify-between gap-3">
                    <h2
                        className="text-[1.05rem] leading-[1.45] font-[650] tracking-[-0.015em]"
                        id="identity-heading"
                    >
                        Independent identity service
                    </h2>
                    <Badge>Identity preview</Badge>
                </div>
                <p className="text-[0.925rem] leading-[1.7] text-primary-300">
                    Authelia continues to handle production sign-ins. The isolated Homelab
                    identity service implements account security, OIDC and ForwardAuth; it
                    has not replaced the existing service.
                </p>
                <ul className="mt-4.5 list-disc pl-5.25 text-[0.925rem] leading-[1.8] text-primary-300">
                    <li>
                        Review account security in Settings and validate explicit access
                        policies.
                    </li>
                    <li>
                        Verify desktop security keys, mobile NFC, and existing client
                        flows.
                    </li>
                    <li>Keep a tested rollback path before replacing Authelia.</li>
                </ul>
            </Card>
        </>
    );
}
