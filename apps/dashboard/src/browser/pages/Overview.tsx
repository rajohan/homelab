import { Card } from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Blocks, Check, ShieldCheck } from "lucide-react";

import { systemStatusQuery } from "../api/client";
import { ConnectionStatus } from "../features/overview/ConnectionStatus";

export function Overview() {
    const status = useQuery(systemStatusQuery);
    return (
        <>
            <div className="mb-7.25 max-[640px]:mb-5.75">
                <span className="text-[0.65rem] font-[650] tracking-[0.12em] text-[#68798e] uppercase">
                    Overview
                </span>
                <h1 className="mt-2.5 mb-3.25 text-[clamp(1.8rem,3vw,2.5rem)] leading-[1.2] font-[650] tracking-[-0.045em]">
                    A clear home for your homelab.
                </h1>
                <p className="text-[0.925rem] leading-[1.7] text-[#536174]">
                    A modular dashboard, starting with a small, independent foundation.
                </p>
            </div>
            <div className="mb-6.25 flex items-start gap-3.25 rounded-[11px] border border-[#ccdbee] bg-[#eef4fd] px-5 py-4.5 text-[#2b538d] max-[640px]:p-4">
                <ShieldCheck className="mt-0.5 shrink-0" size={21} aria-hidden="true" />
                <div>
                    <strong className="text-[0.85rem] font-[650]">
                        Authelia remains in place.
                    </strong>
                    <p className="mt-0.75 text-[0.8rem] leading-[1.7] text-[#496280]">
                        This preview has not replaced authentication or changed access to
                        your services.
                    </p>
                </div>
            </div>
            <div className="grid grid-cols-2 gap-5.5 max-[1050px]:grid-cols-1">
                <ConnectionStatus
                    pending={status.isPending}
                    failed={status.isError}
                    data={status.data}
                    onRetry={() => {
                        void status.refetch();
                    }}
                />
                <Card aria-labelledby="foundation-heading">
                    <div className="mb-4.5 flex items-start justify-between gap-3">
                        <h2
                            className="text-[1.05rem] leading-[1.45] font-[650] tracking-[-0.015em]"
                            id="foundation-heading"
                        >
                            A focused starting point
                        </h2>
                        <Blocks
                            className="shrink-0 text-[#75869b]"
                            size={20}
                            aria-hidden="true"
                        />
                    </div>
                    <p className="text-[0.925rem] leading-[1.7] text-[#536174]">
                        Dashboard and identity are separate applications in one workspace.
                        Shared code stays small and explicit.
                    </p>
                    <ul className="mt-5 grid list-none gap-2.75 p-0 text-[0.8rem] text-[#526176]">
                        <li className="flex items-center gap-2.25">
                            <Check
                                className="shrink-0 text-[#548068]"
                                size={17}
                                aria-hidden="true"
                            />
                            Independent application entry points
                        </li>
                        <li className="flex items-center gap-2.25">
                            <Check
                                className="shrink-0 text-[#548068]"
                                size={17}
                                aria-hidden="true"
                            />
                            Typed API and shared UI primitives
                        </li>
                        <li className="flex items-center gap-2.25">
                            <Check
                                className="shrink-0 text-[#548068]"
                                size={17}
                                aria-hidden="true"
                            />
                            No production credentials required
                        </li>
                    </ul>
                </Card>
            </div>
            <Card
                className="mt-5.5 flex items-center justify-between gap-6.25 max-[1050px]:flex-col max-[1050px]:items-start"
                aria-labelledby="next-step-heading"
            >
                <div>
                    <span className="text-[0.65rem] font-[650] tracking-[0.12em] text-[#68798e] uppercase">
                        Next milestone
                    </span>
                    <h2
                        className="my-2 text-[1.05rem] leading-[1.45] font-[650] tracking-[-0.015em]"
                        id="next-step-heading"
                    >
                        Validate identity before cutover.
                    </h2>
                    <p className="max-w-147.5 text-[0.85rem] leading-[1.7] text-[#536174]">
                        Verify real devices and client integrations alongside Authelia
                        before considering a cutover.
                    </p>
                </div>
                <Link
                    to="/identity"
                    className="inline-flex items-center gap-2 text-[0.8rem] font-semibold whitespace-nowrap text-[#2c568f] hover:underline"
                >
                    View the boundary
                    <ArrowRight size={17} aria-hidden="true" />
                </Link>
            </Card>
        </>
    );
}
