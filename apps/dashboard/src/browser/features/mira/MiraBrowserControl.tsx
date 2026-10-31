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
import { Globe } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { MiraDisableDialog } from "./MiraDisableDialog";

/**
 * Expose the existing account-level browser pause without granting access to a site.
 * @returns A shared control card; each browser session still requires a separate Chat grant.
 */
export function MiraBrowserControl() {
    const [paused, setPaused] = useState<MiraSwitch>();
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
    const control = controls.data?.find((entry) => entry.key === "computer:browser");
    const error = controls.error ?? enable.error;
    return (
        <Card className="space-y-4">
            <SectionHeader
                title="Browser"
                icon={Globe}
                description="Use an isolated browser on the server. Choose websites and access for each run in Chat."
                badge={control && <Badge>{control.enabled ? "Enabled" : "Paused"}</Badge>}
                actions={
                    control && (
                        <Button
                            variant="secondary"
                            className="w-full min-[30rem]:w-auto"
                            disabled={Boolean(controls.error)}
                            busy={enable.isPending}
                            onClick={() =>
                                control.enabled
                                    ? setPaused(control)
                                    : enable.mutate(control)
                            }
                        >
                            {control.enabled ? "Pause Browser" : "Enable Browser"}
                        </Button>
                    )
                }
            />
            {controls.isPending && <LoadingState label="Loading browser control…" />}
            {error && <ErrorNotice error={error} />}
            {control && !control.enabled && control.reason && (
                <p className="text-sm text-primary-400">{control.reason}</p>
            )}
            {paused && (
                <MiraDisableDialog
                    control={paused}
                    title="Browser"
                    description="Stops browser access and prevents new sessions. Choose websites and access again in Chat when you resume."
                    onClose={() => setPaused(undefined)}
                />
            )}
        </Card>
    );
}
