import { SectionPanel } from "@homelab/ui";
import { Boxes } from "lucide-react";
import { useState } from "react";

import { ApplicationDetails } from "../infrastructure/ApplicationDetails";
import { MonitoredApplicationDirectory } from "../infrastructure/MonitoredApplicationDirectory";
import { OverviewLink } from "./OverviewLink";
import type { OverviewReadings } from "./useOverviewReadings";

/** Browse all observed applications by their reported project and inspect a real application in place.
 * @returns Project groups with source freshness and access to the full infrastructure inventory.
 */
export function MonitoredDirectory({
    readings: r,
}: {
    readonly readings: OverviewReadings;
}) {
    const [selected, setSelected] = useState<string>();
    const all = r.infra.inventory?.applications ?? [];
    const active = all.find((item) => item.id === selected);
    const unknownApps = r.apps.filter((a) => a.state === "unknown").length;
    const failedChecks = r.probes.filter((p) => p.state === "unhealthy").length;
    return (
        <SectionPanel
            icon={Boxes}
            title="Monitored applications"
            actions={
                <OverviewLink to="/infrastructure" hash="applications">
                    View inventory
                </OverviewLink>
            }
        >
            {!r.inventory && (
                <p className="text-sm text-primary-400">
                    Current application health unavailable
                </p>
            )}
            {r.inventory && (unknownApps > 0 || failedChecks > 0) && (
                <div className="flex flex-wrap items-center gap-x-5 gap-y-1">
                    {unknownApps > 0 && (
                        <OverviewLink to="/infrastructure" hash="applications">
                            {unknownApps}{" "}
                            {unknownApps === 1 ? "application" : "applications"} with
                            unknown health
                        </OverviewLink>
                    )}
                    {failedChecks > 0 && (
                        <OverviewLink to="/infrastructure" hash="services">
                            {failedChecks} failed{" "}
                            {failedChecks === 1 ? "check" : "checks"}
                        </OverviewLink>
                    )}
                </div>
            )}
            <MonitoredApplicationDirectory
                applications={all}
                stale={r.infra.stale}
                onSelect={(item) => setSelected(item.id)}
            />
            {r.inventory && all.length === 0 && (
                <p className="text-sm text-primary-400">No applications reported.</p>
            )}
            {active && r.infra.inventory && (
                <ApplicationDetails
                    application={active}
                    applications={all}
                    capturedAt={r.infra.inventory.capturedAt}
                    cores={
                        r.infra.inventory?.hosts.find((host) => host.host === active.host)
                            ?.cores ?? null
                    }
                    stale={r.infra.stale}
                    onClose={() => setSelected(undefined)}
                />
            )}
        </SectionPanel>
    );
}
