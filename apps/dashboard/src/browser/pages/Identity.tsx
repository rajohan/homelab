import { Badge, Card } from "@homelab/ui";

export function Identity() {
    return (
        <>
            <div className="mb-7.25 max-[640px]:mb-5.75">
                <span className="text-[0.65rem] font-[650] tracking-[0.12em] text-[#68798e] uppercase">
                    Identity
                </span>
                <h1 className="mt-2.5 mb-3.25 text-[clamp(1.8rem,3vw,2.5rem)] leading-[1.2] font-[650] tracking-[-0.045em]">
                    One identity. Clear boundaries.
                </h1>
                <p className="text-[0.925rem] leading-[1.7] text-[#536174]">
                    A separate identity application serves the dashboard and other
                    approved clients.
                </p>
            </div>
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
                <p className="text-[0.925rem] leading-[1.7] text-[#536174]">
                    Authelia continues to handle production sign-ins. The isolated Homelab
                    identity service implements account security, OIDC and ForwardAuth; it
                    has not replaced the existing service.
                </p>
                <ul className="mt-4.5 list-disc pl-5.25 text-[0.925rem] leading-[1.8] text-[#536174]">
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
