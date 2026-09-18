import { expect, mock, test } from "bun:test";

import type {
    InfrastructureHost,
    InfrastructureInventory,
} from "@homelab/contracts/infrastructure";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";

import { Infrastructure } from "../../pages/Infrastructure";
import { ApplicationInventory } from "./ApplicationInventory";
import { ApplicationMemory } from "./ApplicationMemory";
import { HostInventory } from "./HostInventory";
import { HostResources } from "./HostResources";
import { HostStorageUsage } from "./HostStorageUsage";
import { ResourceStatus } from "./ResourceStatus";
import { ResourceUsage } from "./ResourceUsage";
import { ServiceInventory } from "./ServiceInventory";
import { StorageInventory } from "./StorageInventory";

function renderSized(children: ReactNode) {
    return render(
        <div
            ref={(element) => {
                // Happy DOM does not calculate the viewport dimensions needed by virtual rows.
                for (const viewport of element?.querySelectorAll("section[aria-label]") ??
                    []) {
                    Object.defineProperties(viewport, {
                        offsetHeight: { value: 520, configurable: true },
                        offsetWidth: { value: 960, configurable: true },
                    });
                }
            }}
        >
            {children}
        </div>
    );
}

test("unknown health and missing capacity are explicit", () => {
    render(
        <>
            <ResourceStatus state="unknown" />
            <ResourceUsage used={null} total={null} />
        </>
    );
    expect(screen.getByText("Unknown")).toBeVisible();
    expect(screen.getAllByText(/Not reported/).length).toBeGreaterThan(0);
    expect(screen.queryByText("0 B")).not.toBeInTheDocument();
});

test("host filters do not invent hosts when the selected source is empty", async () => {
    render(<HostInventory hosts={[]} filesystems={[]} onSelect={mock(() => {})} />);
    await userEvent
        .setup()
        .type(screen.getByRole("searchbox", { name: "Search hosts" }), "missing");
    await userEvent
        .setup()
        .click(screen.getByRole("button", { name: "Clear host search" }));
    expect(screen.getByRole("searchbox", { name: "Search hosts" })).toHaveValue("");
    expect(screen.getByText("No hosts match these filters.")).toBeVisible();
});

test("the inventory reports an empty first snapshot instead of claiming healthy infrastructure", () => {
    const client = new QueryClient({
        defaultOptions: { queries: { enabled: false, retry: false } },
    });
    client.setQueryData(["operations", "infrastructure", "inventory"], {
        inventory: null,
        checkedAt: Date.now(),
    });
    render(
        <QueryClientProvider client={client}>
            <Infrastructure />
        </QueryClientProvider>
    );
    expect(screen.getByText(/No resource inventory yet/)).toBeVisible();
    expect(screen.queryByText("Live inventory")).not.toBeInTheDocument();
    client.clear();
});

const host: InfrastructureHost = {
    id: "guest",
    name: "Example VM",
    host: "guest",
    guestId: "qemu/100",
    kind: "vm",
    node: "hypervisor",
    pveInstance: "example.test",
    state: "healthy",
    cpuPercent: 12,
    cores: 4,
    memoryUsed: 1024,
    memoryTotal: 8192,
    allocatedMemory: 8192,
    memorySource: "guest",
    swapUsed: 0,
    swapTotal: 0,
    load: [0.1, 0.2, 0.3],
    uptime: 5000,
    provisionedDisk: 20_000,
    guestMetricsAvailable: true,
};
const inventory: InfrastructureInventory = {
    capturedAt: "2020-01-01T00:00:00.000Z",
    hosts: [host],
    filesystems: [
        {
            id: "fs",
            host: "guest",
            mount: "/data",
            device: "sda",
            type: "ext4",
            used: 1024,
            size: 8192,
            available: 7168,
            readOnly: false,
        },
    ],
    networks: [
        {
            id: "eth0",
            host: "guest",
            device: "eth0",
            virtual: false,
            up: true,
            speed: 125_000_000,
            receive: 1024,
            transmit: 2048,
            errors: 0,
            drops: 0,
        },
        {
            id: "br0",
            host: "guest",
            device: "br0",
            virtual: true,
            up: null,
            speed: null,
            receive: null,
            transmit: null,
            errors: null,
            drops: null,
        },
    ],
    disks: [
        {
            id: "disk",
            host: "guest",
            device: "sda",
            read: 1024,
            write: 2048,
            operations: 10,
            busyPercent: 1,
        },
    ],
    storage: [
        {
            id: "pool",
            name: "Pool",
            node: "hypervisor",
            type: "zfspool",
            state: "healthy",
            size: 8192,
            used: 1024,
        },
    ],
    diskHealth: [
        {
            id: "smart",
            host: "hypervisor",
            device: "ssd",
            state: "healthy",
            temperature: 31,
            wearPercent: 2,
        },
    ],
    applications: [
        {
            id: "app",
            host: "guest",
            project: "tools",
            name: "Example app",
            state: "unknown",
            healthcheck: true,
            restarts: 0,
            startedAt: 1,
        },
    ],
    services: [
        { id: "probe", host: "external", name: "HTTPS", kind: "probe", state: "healthy" },
        {
            id: "node",
            host: "guest",
            name: "node exporter",
            kind: "exporter",
            state: "unhealthy",
        },
    ],
};

test("fresh inventory shows its live status without a changing timestamp label", () => {
    const client = new QueryClient({
        defaultOptions: { queries: { enabled: false, retry: false } },
    });
    const now = Date.now();
    client.setQueryData(["operations", "infrastructure", "inventory"], {
        inventory: { ...inventory, capturedAt: new Date(now).toISOString() },
        checkedAt: now,
    });
    const view = renderSized(
        <QueryClientProvider client={client}>
            <Infrastructure />
        </QueryClientProvider>
    );
    try {
        const status = screen.getByText("Live inventory");
        expect(status).toBeVisible();
        expect(status).toHaveClass("text-emerald-300");
        expect(status.closest("header")).toContainElement(
            screen.getByRole("heading", { name: "Infrastructure", level: 1 })
        );
        expect(screen.queryByText(/^Updated/)).not.toBeInTheDocument();
        expect(screen.queryByText("Stale inventory")).not.toBeInTheDocument();
    } finally {
        view.unmount();
        client.clear();
    }
});

test("a stale inventory remains visibly historical and a host opens its own scoped details", async () => {
    const client = new QueryClient({
        defaultOptions: { queries: { enabled: false, retry: false } },
    });
    client.setQueryData(["operations", "infrastructure", "inventory"], {
        inventory,
        checkedAt: Date.now(),
    });
    client.setQueryData(
        ["operations", "infrastructure", "history", "guest", "6h", "eth0", "sda"],
        { capturedAt: inventory.capturedAt, cpu: [], memory: [], network: [], disk: [] }
    );
    const view = renderSized(
        <QueryClientProvider client={client}>
            <Infrastructure />
        </QueryClientProvider>
    );
    try {
        const status = screen.getByText("Stale inventory");
        expect(status).toBeVisible();
        expect(status).toHaveClass("text-amber-300");
        expect(status.closest("header")).toContainElement(
            screen.getByRole("heading", { name: "Infrastructure", level: 1 })
        );
        expect(screen.queryByText(/values are historical/)).not.toBeInTheDocument();
        expect(screen.queryByText(/^Updated/)).not.toBeInTheDocument();
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Inspect Example VM" }));
        expect(screen.getByRole("dialog", { name: "Example VM" })).toBeVisible();
        const title = screen.getByRole("heading", { name: "Example VM" });
        expect(title.parentElement).toHaveTextContent("Healthy");
        expect(screen.queryByText(/Hypervisor disk allocation/)).not.toBeInTheDocument();
        expect(
            screen.queryByText(/Rate measurements use five-minute/)
        ).not.toBeInTheDocument();
        expect(screen.getAllByText("No measurements for this time range.")).toHaveLength(
            4
        );
        await user.click(screen.getByRole("button", { name: "Close dialog" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    } finally {
        view.unmount();
        client.clear();
    }
});

test("virtual interfaces are opt-in and retain missing values", async () => {
    renderSized(<HostResources host={host} inventory={inventory} section="network" />);
    expect(screen.queryByText(/five-minute averages/)).not.toBeInTheDocument();
    expect(screen.getByText("eth0")).toBeVisible();
    expect(screen.queryByText("br0")).not.toBeInTheDocument();
    await userEvent
        .setup()
        .click(screen.getByRole("switch", { name: "Show virtual interfaces" }));
    expect(screen.getByText("br0")).toBeVisible();
    expect(screen.getByText("1 Gbit/s")).toBeVisible();
});

test("inventory tables share the compact mobile layout and aligned capacity labels", () => {
    const view = renderSized(
        <>
            <HostInventory
                hosts={inventory.hosts}
                filesystems={inventory.filesystems}
                onSelect={mock(() => {})}
            />
            <StorageInventory pools={inventory.storage} disks={inventory.diskHealth} />
            <ApplicationInventory applications={inventory.applications} />
            <ServiceInventory services={inventory.services} />
        </>
    );
    try {
        for (const table of screen.getAllByRole("table")) {
            const rows = table.querySelectorAll("tbody tr[data-index]");
            expect(rows.length).toBeGreaterThan(0);
            for (const row of rows) {
                expect(row).toHaveClass("@max-[48rem]:grid-cols-2");
            }
        }
        const hostTable = screen.getByRole("table", { name: "Hosts and guests" });
        for (const description of ["Inside guest / OS", "/data"]) {
            const label = within(hostTable).getByText(description);
            expect(label.parentElement?.firstElementChild).toHaveTextContent(
                "1 KiB / 8 KiB"
            );
            expect(label.parentElement?.lastElementChild).toBe(label);
            expect(label.closest("td")).not.toHaveClass("@max-[48rem]:col-span-2");
        }
    } finally {
        view.unmount();
    }
});

test("disk I/O is labelled independently of filesystem capacity", () => {
    renderSized(<HostResources host={host} inventory={inventory} section="disks" />);
    expect(screen.getByText("sda")).toBeVisible();
    expect(screen.getByText("1 KiB/s")).toBeVisible();
    expect(screen.getByText(/Block-device I\/O, not free space/)).toBeVisible();
});

test("guest details explain exporter absence instead of showing empty healthy tables", () => {
    render(
        <HostResources
            host={{ ...host, guestMetricsAvailable: false }}
            inventory={inventory}
            section="network"
        />
    );
    expect(screen.getByText(/Guest-level metrics are unavailable/)).toBeVisible();
});

test("application search and check categories stay independent", async () => {
    renderSized(
        <>
            <ApplicationInventory applications={inventory.applications} />
            <ServiceInventory services={inventory.services} />
        </>
    );
    const user = userEvent.setup();
    expect(screen.getByText("Example app")).toBeVisible();
    await user.type(
        screen.getByRole("searchbox", { name: "Search applications" }),
        "does not exist"
    );
    expect(screen.queryByText("Example app")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear application search" }));
    expect(screen.getByText("Example app")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Check type" }));
    await user.click(screen.getByRole("option", { name: "Metrics exporters" }));
    expect(screen.getByText("node exporter")).toBeVisible();
    expect(screen.queryByText("HTTPS")).not.toBeInTheDocument();
});

test("application details show their own usage against the effective memory ceiling", async () => {
    const client = new QueryClient({
        defaultOptions: { queries: { enabled: false, retry: false } },
    });
    client.setQueryData(
        ["operations", "infrastructure", "applicationHistory", "app", "6h"],
        { capturedAt: inventory.capturedAt, cpu: [], memory: [], network: [], disk: [] }
    );
    const application = inventory.applications[0];
    if (!application) throw new Error("Missing fixture application");
    const resources = {
        sampledAt: 1,
        cpuPercent: 11.25,
        memoryUsed: 1024,
        memoryLimit: 0,
        memoryCapacity: 8192,
        pids: 4,
        networkShared: true,
        receive: 0,
        transmit: null,
        read: null,
        write: null,
    };
    const view = renderSized(
        <QueryClientProvider client={client}>
            <ApplicationInventory applications={[{ ...application, resources }]} />
        </QueryClientProvider>
    );
    try {
        const user = userEvent.setup();
        await user.click(screen.getByRole("button", { name: "Inspect Example app" }));
        expect(screen.getByRole("dialog", { name: "Example app" })).toBeVisible();
        const dialog = within(screen.getByRole("dialog", { name: "Example app" }));
        expect(
            dialog.getByRole("heading", { name: "Example app" }).parentElement
        ).toHaveTextContent("Unknown");
        for (const text of [
            "Health check",
            "Received / sent",
            "Read / written",
            "Working set, excluding inactive file cache",
            "Current instance only",
        ]) {
            expect(dialog.queryByText(text)).not.toBeInTheDocument();
        }
        expect(dialog.queryByText(/Sampled/)).not.toBeInTheDocument();
        expect(screen.queryByText("No memory limit")).not.toBeInTheDocument();
        expect(dialog.getByText("Memory capacity")).toBeVisible();
        expect(dialog.getByText("8 KiB")).toBeVisible();
        expect(screen.queryByText(/shares a network namespace/)).not.toBeInTheDocument();
        expect(screen.queryByText(/100%.*one.*core/)).not.toBeInTheDocument();
        expect(dialog.getByText("11.3%")).toBeVisible();
        expect(screen.getAllByText("No measurements for this time range.")).toHaveLength(
            4
        );
        await user.click(screen.getByRole("button", { name: "Close dialog" }));
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    } finally {
        view.unmount();
        client.clear();
    }
});

test("application memory bars require the application's measured capacity", () => {
    render(
        <ApplicationMemory
            resources={{
                sampledAt: 1,
                cpuPercent: null,
                memoryUsed: 1024,
                memoryLimit: 8192,
                memoryCapacity: 8192,
                pids: null,
                networkShared: false,
                receive: null,
                transmit: null,
                read: null,
                write: null,
            }}
        />
    );
    expect(screen.getByText("1 KiB")).toBeVisible();
    expect(screen.getByText("/ 8 KiB")).toBeVisible();
});

test("filesystem details retain their own capacity and mount identity", () => {
    renderSized(
        <HostResources host={host} inventory={inventory} section="filesystems" />
    );
    expect(screen.getByText("/data")).toBeVisible();
    expect(screen.getByText("1 KiB")).toBeVisible();
});

test("unreported storage remains explicit", () => {
    render(<StorageInventory pools={[]} disks={[]} />);
    expect(screen.getByText("Storage metrics have not been reported.")).toBeVisible();
});

test("host storage shows used and total per filesystem, never sums overlapping capacity", () => {
    const filesystem = inventory.filesystems[0];
    if (!filesystem) throw new Error("Missing filesystem fixture");
    render(
        <HostStorageUsage
            host="guest"
            filesystems={[
                ...inventory.filesystems,
                { ...filesystem, id: "data", mount: "/other", used: 2048 },
            ]}
        />
    );
    expect(screen.getByText("/data")).toBeVisible();
    expect(screen.getByText("/other")).toBeVisible();
    expect(screen.getByText("1 KiB")).toBeVisible();
    expect(screen.getByText("2 KiB")).toBeVisible();
    expect(screen.queryByText("3 KiB")).not.toBeInTheDocument();
});

test("hypervisor summaries stay compact while details retain every dataset", () => {
    const filesystem = inventory.filesystems[0];
    if (!filesystem) throw new Error("Missing filesystem fixture");
    const filesystems = [
        { ...filesystem, id: "root", mount: "/" },
        { ...filesystem, id: "pool", mount: "/pool" },
        { ...filesystem, id: "nested", mount: "/pool/guest" },
    ];
    const view = render(
        <HostStorageUsage host="guest" filesystems={filesystems} systemOnly />
    );
    expect(screen.getByText("/")).toBeVisible();
    expect(screen.queryByText(/more filesystems in details/)).not.toBeInTheDocument();
    expect(screen.queryByText("/pool")).not.toBeInTheDocument();
    expect(screen.queryByText("/pool/guest")).not.toBeInTheDocument();
    view.unmount();
    renderSized(
        <HostResources
            host={host}
            inventory={{ ...inventory, filesystems }}
            section="filesystems"
        />
    );
    expect(screen.getByText("/pool")).toBeVisible();
    expect(screen.getByText("/pool/guest")).toBeVisible();
});
