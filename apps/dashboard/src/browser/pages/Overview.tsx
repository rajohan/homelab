import { Card, PageHeader, SectionHeader, buttonStyles } from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";

import { systemStatusQuery } from "../api/client";
import { AlertsPanel } from "../features/alerts/AlertsPanel";
import { BackupsPanel } from "../features/backups/BackupsPanel";
import { ConnectionStatus } from "../features/overview/ConnectionStatus";
import { InfrastructureHealth } from "../features/overview/InfrastructureHealth";
import { QueueSummary } from "../features/overview/QueueSummary";
import { UpdatesPanel } from "../features/updates/UpdatesPanel";

/**
 * Compose operational domains with independent queries, loading and failure boundaries.
 * @returns A responsive health overview linked to each domain's canonical details.
 */
export function Overview() {
    const status = useQuery(systemStatusQuery);
    const operationsAvailable = !status.isError && status.data?.operationsConfigured;
    return (
        <>
            <PageHeader
                title="Overview"
                description="System health, protection and work that needs attention."
            />
            {operationsAvailable ? (
                <div className="space-y-5">
                    <InfrastructureHealth />
                    <div className="grid items-start gap-5 xl:grid-cols-2">
                        <AlertsPanel compact />
                        <BackupsPanel compact />
                        <UpdatesPanel compact />
                        <QueueSummary />
                    </div>
                </div>
            ) : (
                <div className="grid gap-5 lg:grid-cols-2">
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
                            {status.isSuccess && !status.data.operationsConfigured
                                ? "Operations are not configured. Account settings and sign-in remain available."
                                : "Account settings remain available while the dashboard connection is checked."}
                        </p>
                        <Link
                            to="/settings"
                            className={buttonStyles({
                                variant: "secondary",
                                className: "mt-auto self-start",
                            })}
                        >
                            Open settings
                        </Link>
                    </Card>
                </div>
            )}
        </>
    );
}
