import type {
    AvailabilityKind,
    InfrastructureInventory,
} from "@homelab/contracts/infrastructure";
import { SectionPanel, Select } from "@homelab/ui";
import { History } from "lucide-react";
import { useState } from "react";

import { AvailabilityReadings } from "./AvailabilityReadings";

interface Option {
    readonly id: string;
    readonly label: string;
    readonly group: string;
}

function resourceGroups(inventory: InfrastructureInventory): readonly {
    key: string;
    label: string;
    kind: AvailabilityKind;
    options: readonly Option[];
}[] {
    const hosts = inventory.hosts.map((row) => ({
        id: row.id,
        label: row.name,
        group: "",
        guest: row.kind === "vm" || row.kind === "container",
    }));
    return [
        {
            key: "host",
            label: "Physical hosts",
            kind: "host",
            options: hosts.filter((row) => !row.guest),
        },
        {
            key: "guest",
            label: "Guests",
            kind: "host",
            options: hosts.filter((row) => row.guest),
        },
        {
            key: "app",
            label: "Applications",
            kind: "application",
            options: inventory.applications.map((r) => ({
                id: r.id,
                label: r.name,
                group: r.host + " · " + r.project,
            })),
        },
        ...(["probe", "service", "exporter"] as const).map((kind) => ({
            key: kind,
            label: {
                probe: "End-to-end probes",
                service: "System services",
                exporter: "Metrics exporters",
            }[kind],
            kind: "service" as const,
            options: inventory.services
                .filter((r) => r.kind === kind)
                .map((r) => ({ id: r.id, label: r.name, group: r.host })),
        })),
        {
            key: "storage",
            label: "Storage pools",
            kind: "storage",
            options: inventory.storage.map((r) => ({
                id: r.id,
                label: r.name,
                group: r.node,
            })),
        },
        {
            key: "disk",
            label: "Physical disks",
            kind: "diskHealth",
            options: inventory.diskHealth.map((r) => ({
                id: r.id,
                label: r.device,
                group: r.host,
            })),
        },
        {
            key: "network",
            label: "Network interfaces",
            kind: "network",
            options: inventory.networks.map((r) => ({
                id: r.id,
                label: r.device,
                group: r.host,
            })),
        },
        {
            key: "filesystem",
            label: "Filesystems",
            kind: "filesystem",
            options: inventory.filesystems.map((r) => ({
                id: r.id,
                label: r.mount + " · " + r.device,
                group: r.host,
            })),
        },
    ];
}

/** Browse retained availability without issuing a history query for every inventory row.
 * @returns A responsive resource picker and five windows for its selected resource.
 */
export function AvailabilityBrowser({
    inventory,
}: {
    readonly inventory: InfrastructureInventory;
}) {
    const [category, setCategory] = useState("host");
    const [group, setGroup] = useState("");
    const [id, setId] = useState("");
    const categories = resourceGroups(inventory).filter(
        (item) => item.options.length > 0
    );
    const selected = categories.find((item) => item.key === category) ?? categories[0];
    const groups = [...new Set(selected?.options.map((row) => row.group))].toSorted();
    const activeGroup = groups.includes(group) ? group : groups[0];
    const options =
        selected?.options
            .filter((row) => row.group === activeGroup)
            .toSorted((a, b) => a.label.localeCompare(b.label)) ?? [];
    const current = options.find((row) => row.id === id) ?? options[0];
    return (
        <SectionPanel icon={History} title="Availability">
            {selected && current ? (
                <>
                    <div className="grid min-w-0 gap-2 sm:grid-cols-[repeat(auto-fit,minmax(12rem,1fr))]">
                        <Select
                            label="Resource category"
                            options={categories.map((item) => ({
                                value: item.key,
                                label: item.label,
                            }))}
                            value={selected.key}
                            onChange={(key) => {
                                setCategory(key);
                                setGroup("");
                                setId("");
                            }}
                        />
                        {activeGroup && groups.length > 1 && (
                            <Select
                                label="Host or service group"
                                options={groups.map((name) => ({
                                    value: name,
                                    label: name,
                                }))}
                                value={activeGroup}
                                onChange={(value) => {
                                    setGroup(value);
                                    setId("");
                                }}
                            />
                        )}
                        <Select
                            label="Monitored resource"
                            options={options.map((row) => ({
                                value: row.id,
                                label: row.label,
                            }))}
                            value={current.id}
                            onChange={setId}
                        />
                    </div>
                    <AvailabilityReadings kind={selected.kind} id={current.id} />
                </>
            ) : (
                <p className="text-sm text-primary-400">
                    No monitored resources have been reported.
                </p>
            )}
        </SectionPanel>
    );
}
