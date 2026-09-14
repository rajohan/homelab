import { Badge, Card } from "@homelab/ui";

export function Infrastructure() {
    return (
        <>
            <div className="mb-7.25 max-[640px]:mb-5.75">
                <span className="text-[0.65rem] font-[650] tracking-[0.12em] text-[#68798e] uppercase">
                    Infrastructure
                </span>
                <h1 className="mt-2.5 mb-3.25 text-[clamp(1.8rem,3vw,2.5rem)] leading-[1.2] font-[650] tracking-[-0.045em]">
                    Your systems, together.
                </h1>
                <p className="text-[0.925rem] leading-[1.7] text-[#536174]">
                    Infrastructure modules will be added after the identity foundation is
                    ready.
                </p>
            </div>
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
                <p className="text-[0.925rem] leading-[1.7] text-[#536174]">
                    This preview does not query servers, monitoring, backups, or OpenClaw.
                    It displays no synthetic health metrics and exposes no administrative
                    actions.
                </p>
                <p className="mt-3.5 text-[0.925rem] leading-[1.7] text-[#536174]">
                    Future modules will own their API contracts and access permissions
                    without becoming dependencies of the identity service.
                </p>
            </Card>
        </>
    );
}
