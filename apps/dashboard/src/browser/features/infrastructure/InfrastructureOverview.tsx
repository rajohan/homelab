import type { InfrastructureInventory } from "@homelab/contracts/infrastructure";
import { PageSections } from "@homelab/ui";
import { useState } from "react";

import { ApplicationCatalog } from "../applications/ApplicationCatalog";
import { HostDetails } from "./HostDetails";
import { HostInventory } from "./HostInventory";
import { ServiceInventory } from "./ServiceInventory";
import { StorageInventory } from "./StorageInventory";

/**
 * Present one coherent infrastructure snapshot with resource summaries and scoped details.
 * @returns Read-only host, storage, application and service visibility.
 */
export function InfrastructureOverview({
    inventory,
    loading,
    stale,
}: {
    readonly stale: boolean;
    readonly inventory: InfrastructureInventory | null | undefined;
    readonly loading: boolean;
}) {
    const [selected, setSelected] = useState<string | null>(null);
    const host = inventory?.hosts.find((item) => item.id === selected);
    return (
        <div className="space-y-5">
            <PageSections
                label="Infrastructure sections"
                sections={[
                    ...(inventory
                        ? [
                              {
                                  id: "hosts",

                                  label: "Hosts and guests",
                                  content: (
                                      <HostInventory
                                          stale={stale}
                                          hosts={inventory.hosts}
                                          filesystems={inventory.filesystems}
                                          onSelect={(item) => setSelected(item.id)}
                                      />
                                  ),
                              },
                              {
                                  id: "storage",
                                  label: "Storage",
                                  content: (
                                      <StorageInventory
                                          pools={inventory.storage}
                                          disks={inventory.diskHealth}
                                      />
                                  ),
                              },
                          ]
                        : []),
                    {
                        id: "applications",

                        label: "Applications",
                        content: (
                            <ApplicationCatalog
                                inventory={inventory}
                                stale={stale}
                                loading={loading}
                            />
                        ),
                    },
                    ...(inventory
                        ? [
                              {
                                  id: "services",

                                  label: "Services and probes",
                                  content: (
                                      <ServiceInventory
                                          services={inventory.services}
                                          stale={stale}
                                      />
                                  ),
                              },
                          ]
                        : []),
                ]}
            />
            {host && inventory && (
                <HostDetails
                    key={host.id}
                    host={host}
                    stale={stale}
                    inventory={inventory}
                    onClose={() => setSelected(null)}
                />
            )}
        </div>
    );
}
