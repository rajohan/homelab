import type {
    FilesystemMetric,
    InfrastructureHost,
} from "@homelab/contracts/infrastructure";
import { ArrowUpRight, Cpu, Server } from "lucide-react";

import { HostReadings } from "./HostReadings";
import { ResourceStatus } from "./ResourceStatus";

/** Compare physical machines on the same CPU and memory scales, with direct access to the host inspector.
 * @returns A set of measured host panels arranged by available width.
 */
export function HostShelf({
    hosts,
    filesystems,
    stale,
    onSelect,
    compact = false,
}: {
    readonly compact?: boolean;
    readonly filesystems: readonly FilesystemMetric[];
    readonly hosts: readonly InfrastructureHost[];
    readonly stale: boolean;
    readonly onSelect: (host: InfrastructureHost) => void;
}) {
    return (
        <ul
            aria-label="Physical host readings"
            className={
                compact
                    ? "grid min-w-0 grid-cols-[repeat(auto-fit,minmax(min(100%,22rem),1fr))] items-start gap-x-6 gap-y-4"
                    : "grid grid-cols-[repeat(auto-fit,minmax(min(100%,21rem),1fr))] gap-3"
            }
        >
            {hosts.map((host) => (
                <li
                    key={host.id}
                    className={
                        compact
                            ? "min-w-0"
                            : "min-w-0 rounded-xl border border-primary-700 bg-surface-card p-4 sm:p-5"
                    }
                >
                    <div className="flex items-start gap-3">
                        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary-800 text-accent-300">
                            {host.kind === "node" ? (
                                <Server size={23} aria-hidden="true" />
                            ) : (
                                <Cpu size={23} aria-hidden="true" />
                            )}
                        </div>
                        <div className="min-w-0 flex-1">
                            <button
                                type="button"
                                onClick={() => onSelect(host)}
                                aria-label={`Inspect ${host.name}`}
                                className="group flex min-h-7 max-w-full items-center gap-2 rounded text-left text-xl font-semibold tracking-tight wrap-anywhere hover:text-accent-300 focus-visible:outline-2 focus-visible:outline-accent-300"
                            >
                                {host.name}
                                <ArrowUpRight
                                    size={16}
                                    aria-hidden="true"
                                    className="shrink-0 text-primary-400 group-hover:text-accent-300"
                                />
                            </button>
                            <p className="text-xs text-primary-400">
                                {host.kind === "node" ? "Proxmox node" : "Physical host"}
                            </p>
                        </div>
                        <ResourceStatus state={stale ? "unknown" : host.state} />
                    </div>
                    <div className={compact ? "mt-3" : "mt-5"}>
                        <HostReadings
                            host={host}
                            filesystems={filesystems}
                            stale={stale}
                        />
                    </div>
                </li>
            ))}
        </ul>
    );
}
