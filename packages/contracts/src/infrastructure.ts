export type ResourceState = "healthy" | "unhealthy" | "stopped" | "unknown";
export type HostKind = "node" | "vm" | "container" | "host";

export interface InfrastructureHost {
    readonly id: string;
    readonly name: string;
    readonly kind: HostKind;
    readonly node: string | null;
    readonly guestId: string | null;
    readonly host: string | null;
    readonly pveInstance: string | null;
    readonly state: ResourceState;
    readonly cpuPercent: number | null;
    readonly cores: number | null;
    readonly memoryUsed: number | null;
    readonly memoryTotal: number | null;
    readonly allocatedMemory: number | null;
    readonly memorySource: "guest" | "hypervisor" | "unavailable";
    readonly swapUsed: number | null;
    readonly swapTotal: number | null;
    readonly load: readonly (number | null)[];
    readonly uptime: number | null;
    readonly provisionedDisk: number | null;
    readonly guestMetricsAvailable: boolean;
    /** Node-exporter identity exists independently of scrape health; absent in older snapshots. */
    readonly guestMetricsConfigured?: boolean;
}

export interface FilesystemMetric {
    readonly id: string;
    readonly host: string;
    readonly mount: string;
    readonly device: string;
    readonly type: string;
    readonly size: number | null;
    readonly used: number | null;
    readonly available: number | null;
    readonly readOnly: boolean | null;
}

export interface NetworkMetric {
    readonly id: string;
    readonly host: string;
    readonly device: string;
    readonly virtual: boolean;
    readonly up: boolean | null;
    readonly speed: number | null;
    readonly receive: number | null;
    readonly transmit: number | null;
    readonly errors: number | null;
    readonly drops: number | null;
}

export interface DiskMetric {
    readonly id: string;
    readonly host: string;
    readonly device: string;
    readonly read: number | null;
    readonly write: number | null;
    readonly operations: number | null;
    readonly busyPercent: number | null;
}

export interface StoragePoolMetric {
    readonly id: string;
    readonly name: string;
    readonly node: string;
    readonly type: string;
    readonly state: ResourceState;
    readonly size: number | null;
    readonly used: number | null;
}

export interface ApplicationMetric {
    readonly id: string;
    readonly host: string;
    readonly project: string;
    readonly name: string;
    readonly state: ResourceState;
    readonly restarts: number | null;
    readonly startedAt: number | null;
    readonly healthcheck: boolean;
    /** Older saved snapshots without a source retain Docker history compatibility. */
    readonly resourceSource?: "container" | "native";
    readonly resources?: ApplicationResources;
}

export interface ApplicationResources {
    readonly sampledAt: number;
    readonly cpuPercent: number | null;
    readonly memoryUsed: number | null;
    /** Zero means no explicit application memory limit; null means unavailable. */
    readonly memoryLimit: number | null;
    /** Effective ceiling: the lower of a positive application limit and host RAM. */
    readonly memoryCapacity: number | null;
    readonly pids: number | null;
    readonly networkShared: boolean;
    readonly receive: number | null;
    readonly transmit: number | null;
    readonly read: number | null;
    readonly write: number | null;
}

export interface ServiceMetric {
    readonly id: string;
    readonly host: string;
    readonly name: string;
    readonly kind: "probe" | "service" | "exporter";
    readonly state: ResourceState;
}

export interface DiskHealthMetric {
    readonly id: string;
    readonly host: string;
    readonly device: string;
    readonly state: ResourceState;
    readonly temperature: number | null;
    readonly wearPercent: number | null;
}

export interface InfrastructureInventory {
    readonly capturedAt: string;
    readonly hosts: readonly InfrastructureHost[];
    readonly filesystems: readonly FilesystemMetric[];
    readonly networks: readonly NetworkMetric[];
    readonly disks: readonly DiskMetric[];
    readonly storage: readonly StoragePoolMetric[];
    readonly applications: readonly ApplicationMetric[];
    readonly services: readonly ServiceMetric[];
    readonly diskHealth: readonly DiskHealthMetric[];
}

export const historyRanges = ["1h", "6h", "24h", "7d"] as const;
export type HistoryRange = (typeof historyRanges)[number];
export interface MetricPoint {
    readonly time: number;
    readonly value: number | null;
}
export interface MetricSeries {
    readonly key: string;
    readonly label: string;
    readonly points: readonly MetricPoint[];
}
export interface InfrastructureHistory {
    readonly capturedAt: string;
    readonly cpu: readonly MetricSeries[];
    readonly memory: readonly MetricSeries[];
    readonly network: readonly MetricSeries[];
    readonly disk: readonly MetricSeries[];
}
