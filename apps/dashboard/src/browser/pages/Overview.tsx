import { Badge, Card, PageHeader, SectionHeader, buttonStyles } from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, Server, ShieldCheck } from "lucide-react";

import { systemStatusQuery } from "../api/client";
import { ConnectionStatus } from "../features/overview/ConnectionStatus";

export function Overview() {
    const status = useQuery(systemStatusQuery);
    return (
        <>
            <PageHeader
                title="Overview"
                description="Your account and infrastructure, in one place."
            />
            <div className="mb-6 flex items-start gap-3 rounded-xl border border-accent-800/60 bg-accent-950/40 p-4 text-sm">
                <ShieldCheck
                    size={20}
                    className="mt-0.5 shrink-0 text-accent-300"
                    aria-hidden="true"
                />
                <div>
                    <p className="font-medium text-accent-100">
                        You&apos;re in the identity preview
                    </p>
                    <p className="mt-1 leading-6 text-primary-300">
                        Authelia still protects your services. Explore account settings
                        here before the production switch.
                    </p>
                </div>
            </div>
            <div className="grid gap-6 lg:grid-cols-2">
                <ConnectionStatus
                    pending={status.isPending}
                    failed={status.isError}
                    data={status.data}
                    onRetry={() => void status.refetch()}
                />
                <Card className="flex flex-col gap-5">
                    <SectionHeader
                        title="Account & security"
                        description="Manage the identity you use across your homelab."
                        icon={ShieldCheck}
                    />
                    <p className="text-sm leading-6 text-primary-300">
                        Update your email and password, register security keys, and review
                        your signed-in devices.
                    </p>
                    <Link
                        to="/settings"
                        className={buttonStyles({
                            variant: "secondary",
                            className: "mt-auto self-start",
                        })}
                    >
                        Open settings <ArrowRight size={16} aria-hidden="true" />
                    </Link>
                </Card>
                <Card className="flex flex-col gap-5 lg:col-span-2">
                    <SectionHeader
                        title="Infrastructure"
                        description="Services, hosts and monitoring will live here."
                        icon={Server}
                        actions={<Badge>Not connected</Badge>}
                    />
                    <p className="text-sm leading-6 text-primary-400">
                        Infrastructure integrations have not been enabled in this preview.
                        Existing services continue to run independently.
                    </p>
                    <Link
                        to="/infrastructure"
                        className="inline-flex items-center gap-2 self-start text-sm font-medium text-accent-300 hover:text-accent-200"
                    >
                        View integration plan <ArrowRight size={16} aria-hidden="true" />
                    </Link>
                </Card>
            </div>
        </>
    );
}
