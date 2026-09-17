import { Card, PageHeader, SectionHeader, buttonStyles } from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ArrowRight, ShieldCheck } from "lucide-react";

import { systemStatusQuery } from "../api/client";
import { InfrastructureSummary } from "../features/operations/InfrastructureSummary";
import { ConnectionStatus } from "../features/overview/ConnectionStatus";

/**
 * Combine the API connection, account settings and background monitoring summary.
 * @returns Independent overview modules with their own loading and failure states.
 */
export function Overview() {
    const status = useQuery(systemStatusQuery);
    return (
        <>
            <PageHeader
                title="Overview"
                description="Your account and infrastructure, in one place."
            />
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
                        Update your account, review signed-in devices, and manage scoped
                        access for scripts and services.
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
                <div className="lg:col-span-2">
                    <InfrastructureSummary />
                </div>
            </div>
        </>
    );
}
