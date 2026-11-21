import type { MiraSwitch } from "@homelab/contracts/mira";
import {
    Badge,
    Button,
    CatalogRow,
    ErrorNotice,
    formatDateTime,
    LoadingState,
    SectionPanel,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import {
    Cloud,
    GitPullRequest,
    Globe,
    type LucideIcon,
    Mail,
    MessagesSquare,
    Plug,
    Send,
    Terminal,
} from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { MiraDisableDialog } from "./MiraDisableDialog";

const integrationIcons: Partial<Record<string, LucideIcon>> = {
    "integration:agentmail": Mail,
    "integration:moltbook": MessagesSquare,
    "integration:moltbook-publish": Send,
    "integration:here-now": Globe,
    "integration:daytona": Cloud,
    "integration:github": GitPullRequest,
    "code:main": Terminal,
};

/**
 * Show provisioned integration availability and independent human-controlled pauses.
 * @returns Shared integration cards with clear configuration, connection and recovery states.
 */
export function MiraIntegrations() {
    const [paused, setPaused] = useState<{ control: MiraSwitch; title: string }>();
    const status = useQuery({
        queryKey: ["operations", "mira", "integrations"],
        queryFn: () => api.mira.integrations.query(),
        refetchInterval: 15_000,
    });
    const controls = useQuery({
        queryKey: ["operations", "mira", "controls"],
        queryFn: () => api.mira.controls.list.query(),
        refetchInterval: 15_000,
    });
    const enable = useOperation((control: MiraSwitch) =>
        api.mira.controls.setEnabled.mutate({
            key: control.key,
            version: control.version,
            enabled: true,
            reason: null,
            until: null,
        })
    );
    const error = status.error ?? controls.error ?? enable.error;
    return (
        <SectionPanel title="Integrations" icon={Plug}>
            {error && <ErrorNotice error={error} />}
            {status.isPending && <LoadingState label="Loading integrations…" />}
            <ul className="divide-y divide-primary-700/70">
                {status.data?.map((integration) => {
                    const control = controls.data?.find(
                        (entry) => entry.key === integration.key
                    );
                    let label = "Not configured";
                    if (integration.configured) {
                        label = "Status unavailable";
                        if (control) label = control.enabled ? "Ready" : "Paused";
                    }
                    if (integration.configured && control?.enabled && !integration.ready)
                        label = "Offline";
                    if (
                        integration.ready &&
                        control?.enabled &&
                        integration.lastSuccessAt
                    )
                        label = "Connected";
                    if (
                        integration.configured &&
                        control?.enabled &&
                        integration.ready &&
                        integration.message
                    )
                        label = "Needs attention";
                    return (
                        <CatalogRow
                            key={integration.key}
                            title={integration.title}
                            icon={integrationIcons[integration.key] ?? Plug}
                            status={<Badge tone={integrationTone(label)}>{label}</Badge>}
                            description={integration.description}
                            actions={
                                control &&
                                (control.enabled || integration.configured) && (
                                    <Button
                                        variant="secondary"
                                        size="sm"
                                        disabled={!control.enabled && !integration.ready}
                                        busy={
                                            enable.isPending &&
                                            enable.variables?.key === control.key
                                        }
                                        onClick={() =>
                                            control.enabled
                                                ? setPaused({
                                                      control,
                                                      title: integration.title,
                                                  })
                                                : enable.mutate(control)
                                        }
                                    >
                                        {control.enabled ? "Pause" : "Enable"}
                                    </Button>
                                )
                            }
                        >
                            {control &&
                                !control.enabled &&
                                (control.version > 1 || control.until) && (
                                    <p className="text-sm text-primary-400">
                                        {[
                                            control.reason,
                                            control.until &&
                                                `Resumes ${formatDateTime(control.until)}`,
                                        ]
                                            .filter(Boolean)
                                            .join(" · ")}
                                    </p>
                                )}
                            {integration.message && (
                                <p className="text-sm text-primary-300">
                                    {integration.message}
                                </p>
                            )}
                        </CatalogRow>
                    );
                })}
            </ul>
            {paused && (
                <MiraDisableDialog {...paused} onClose={() => setPaused(undefined)} />
            )}
        </SectionPanel>
    );
}

function integrationTone(label: string) {
    if (label === "Ready" || label === "Connected") return "positive";
    return ["Offline", "Needs attention"].includes(label) ? "warning" : "neutral";
}
