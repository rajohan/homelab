import { Badge, Card, PageHeader } from "@homelab/ui";

export function Infrastructure() {
    return (
        <>
            <PageHeader
                eyebrow="Infrastructure"
                title="Your systems, together."
                description="Infrastructure modules will be added after the identity foundation is ready."
            />
            <Card aria-labelledby="infrastructure-heading">
                <div className="mb-4.5 flex items-start justify-between gap-3">
                    <h2
                        className="text-[1.05rem] leading-[1.45] font-[650] tracking-[-0.015em]"
                        id="infrastructure-heading"
                    >
                        No infrastructure integrations connected
                    </h2>
                    <Badge>Planned</Badge>
                </div>
                <p className="text-[0.925rem] leading-[1.7] text-primary-300">
                    This preview does not query servers, monitoring, backups, or OpenClaw.
                    It displays no synthetic health metrics and exposes no administrative
                    actions.
                </p>
                <p className="mt-3.5 text-[0.925rem] leading-[1.7] text-primary-300">
                    Future modules will own their API contracts and access permissions
                    without becoming dependencies of the identity service.
                </p>
            </Card>
        </>
    );
}
