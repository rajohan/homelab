import type { MiraSwitch } from "@homelab/contracts/mira";
import {
    Badge,
    Button,
    ErrorNotice,
    formatDateTime,
    LoadingState,
    SectionPanel,
} from "@homelab/ui";
import { useQuery } from "@tanstack/react-query";
import { Globe } from "lucide-react";
import { useState } from "react";

import { api } from "../../api/client";
import { useOperation } from "../operations/useOperation";
import { BrowserProfileControls } from "./BrowserProfileControls";
import { MiraDisableDialog } from "./MiraDisableDialog";

/**
 * Expose the existing account-level browser pause without granting access to a site.
 * @returns Account pause and saved-data controls; Mira starts task sessions directly.
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
        <SectionPanel
            title="Browser"
            icon={Globe}
            description="Mira opens the server browser for your requests and closes it when finished."
            badge={
                control && (
                    <Badge tone={control.enabled ? "positive" : "neutral"}>
                        {control.enabled ? "Enabled" : "Paused"}
                    </Badge>
                )
            }
            actions={
                control && (
                    <Button
                        variant="secondary"
                        className="w-full min-[30rem]:w-auto"
                        disabled={Boolean(controls.error)}
                        busy={enable.isPending}
                        onClick={() =>
                            control.enabled ? setPaused(control) : enable.mutate(control)
                        }
                    >
                        {control.enabled ? "Pause Browser" : "Enable Browser"}
                    </Button>
                )
            }
        >
            {controls.isPending && <LoadingState label="Loading browser control…" />}
            {error && <ErrorNotice error={error} />}
            {control && !control.enabled && control.reason && (
                <p className="text-sm text-primary-400">
                    {control.reason}
                    {control.until ? ` · Resumes ${formatDateTime(control.until)}` : ""}
                </p>
            )}
            <BrowserProfileControls />
            {paused && (
                <MiraDisableDialog
                    control={paused}
                    title="Browser"
                    description="Stops the browser and prevents new sessions until Browser is enabled again."
                    onClose={() => setPaused(undefined)}
                />
            )}
        </SectionPanel>
    );
}
