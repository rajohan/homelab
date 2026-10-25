import type { MiraSwitch } from "@homelab/contracts/mira";
import {
    Badge,
    Button,
    Card,
    ErrorNotice,
    LoadingState,
    SectionHeader,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { Globe, Mail, Plug } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { MiraDisableDialog } from "./MiraDisableDialog";

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
        <Card className="space-y-4">
            <SectionHeader
                title="Integrations"
                icon={Plug}
                description="Manage Mira's connections and pause each one independently."
            />
            {error && <ErrorNotice error={error} />}
            {status.isPending && <LoadingState label="Loading integrations…" />}
            {status.data?.map((integration) => {
                const control = controls.data?.find(
                    (entry) => entry.key === integration.key
                );
                let label = "Not configured";
                if (integration.configured) label = control?.enabled ? "Ready" : "Paused";
                if (integration.configured && control?.enabled && !integration.ready)
                    label = "Offline";
                if (integration.ready && control?.enabled && integration.lastSuccessAt)
                    label = "Connected";
                if (
                    integration.configured &&
                    control?.enabled &&
                    integration.ready &&
                    integration.message
                )
                    label = "Needs attention";
                return (
                    <section
                        key={integration.key}
                        className="space-y-3 rounded-lg border border-primary-700 bg-primary-950/40 p-4"
                    >
                        <SectionHeader
                            title={integration.title}
                            icon={
                                integration.key === "integration:agentmail" ? Mail : Globe
                            }
                            badge={<Badge>{label}</Badge>}
                            description={integration.description}
                            actions={
                                control && (
                                    <Button
                                        variant="secondary"
                                        className="w-full min-[30rem]:w-auto"
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
                        />
                        {control && !control.enabled && (
                            <p className="text-sm text-primary-400">{control.reason}</p>
                        )}
                        {integration.message && (
                            <p className="text-sm text-primary-300">
                                {integration.message}
                            </p>
                        )}
                    </section>
                );
            })}
            {paused && (
                <MiraDisableDialog {...paused} onClose={() => setPaused(undefined)} />
            )}
        </Card>
    );
}
