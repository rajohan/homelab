import { ErrorNotice, LoadingState, SectionPanel } from "@homelab/ui";
import { Server } from "lucide-react";
import { useState } from "react";

import { HostDetails } from "../infrastructure/HostDetails";
import { HostShelf } from "../infrastructure/HostShelf";
import { useInfrastructure } from "../infrastructure/useInfrastructure";
import { ObservationBadge } from "../operations/ObservationBadge";
import { OverviewLink } from "./OverviewLink";
import { PhysicalHostHistory } from "./PhysicalHostHistory";

/**
 * Summarize monitoring without adding host and guest allocations or shared storage together.
 * @returns Physical resource visibility and application/probe health from the existing inventory.
 */
export function InfrastructureHealth() {
    const { query, inventory, stale, configured } = useInfrastructure();
    const hosts =
        inventory?.hosts.filter((host) => host.kind === "node" || host.kind === "host") ??
        [];
    const [selectedId, setSelectedId] = useState<string>();
    const selected = hosts.find((host) => host.id === selectedId);
    return (
        <SectionPanel
            icon={Server}
            title="Physical hosts"
            badge={
                <ObservationBadge
                    configured={configured}
                    available={Boolean(inventory)}
                    stale={stale}
                />
            }
            actions={<OverviewLink to="/infrastructure">Infrastructure</OverviewLink>}
        >
            {query.isPending && <LoadingState label="Loading infrastructure…" />}
            {query.isError && <ErrorNotice error={query.error} />}
            {hosts.length > 0 && (
                <div className="grid min-w-0 @min-[53rem]/overview:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
                    <HostShelf
                        compact
                        filesystems={inventory?.filesystems ?? []}
                        hosts={hosts}
                        stale={stale}
                        onSelect={(host) => setSelectedId(host.id)}
                    />
                    <PhysicalHostHistory hosts={hosts} />
                </div>
            )}
            {inventory && selected && (
                <HostDetails
                    host={selected}
                    key={selected.id}
                    stale={stale}
                    inventory={inventory}
                    onClose={() => setSelectedId(undefined)}
                />
            )}
            {!query.isPending && !query.isError && !inventory && (
                <p className="text-sm text-primary-400">
                    No infrastructure observation is available.
                </p>
            )}
            {inventory && hosts.length === 0 && (
                <p className="text-sm text-primary-400">No physical hosts reported.</p>
            )}
        </SectionPanel>
    );
}
