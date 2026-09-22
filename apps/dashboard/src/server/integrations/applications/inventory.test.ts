import { expect, test } from "bun:test";

import {
    collectApplications,
    filterApplicationInventory,
    applicationInventoryByteLimit,
} from "./inventory";

const target = {
    id: "main",
    label: "Main",
    endpoint: "http://fixture.invalid:2375",
    projects: ["demo"],
};

test.each([16 * 1024, applicationInventoryByteLimit])(
    "oversized visibility %i does not remove healthy hosts",
    async (size) => {
        const targets = Array.from({ length: 20 }, (_, index) => ({
            ...target,
            id: "host-" + index,
        }));
        const inventory = await collectApplications(
            targets,
            () => ({
                list: () => Promise.resolve([]),
                inspect: () => {
                    throw new Error("No containers");
                },
                act: () => {
                    throw new Error("Read-only fixture");
                },
            }),
            AbortSignal.timeout(3000),
            undefined,
            1000,
            () =>
                Promise.resolve({
                    time: "2026-01-01T00:00:00.000000Z",
                    visibility: "1:999999:" + "2,".repeat(size / 2),
                })
        );
        expect(inventory.hosts).toHaveLength(20);
        for (const host of inventory.hosts) {
            expect(host.available).toBe(true);
            expect(host).not.toHaveProperty("observationVisibility");
            expect(host).not.toHaveProperty("observationStartedAt");
        }
        expect(
            new TextEncoder().encode(JSON.stringify(inventory)).byteLength
        ).toBeLessThan(applicationInventoryByteLimit);
        const legacy = {
            ...inventory,
            hosts: inventory.hosts.map((host) => ({
                ...host,
                observationStartedAt: inventory.capturedAt,
                observationVisibility: "x".repeat(size + 1),
            })),
        };
        expect(filterApplicationInventory(legacy, targets)).toEqual(inventory);
    }
);

test("a failed observation clock rejects collection without attempting Docker", async () => {
    let connected = false;
    const failure = await collectApplications(
        [target],
        () => {
            connected = true;
            throw new Error("Unexpected Docker call");
        },
        AbortSignal.timeout(1000),
        undefined,
        10,
        async () => {
            await Bun.sleep(1);
            throw new Error("Database unavailable");
        }
    ).then(
        () => null,
        (error: unknown) => error
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toHaveProperty("message", "Database unavailable");
    expect(connected).toBe(false);
});

test("a slow observation clock does not consume the Docker host budget", async () => {
    let read = false;
    const inventory = await collectApplications(
        [target],
        () => ({
            list: (signal) => {
                signal.throwIfAborted();
                read = true;
                return Promise.resolve([]);
            },
            inspect: () => {
                throw new Error("No containers");
            },
            act: () => {
                throw new Error("Read-only fixture");
            },
        }),
        AbortSignal.timeout(1000),
        undefined,
        10,
        async () => {
            await Bun.sleep(30);
            return { time: "2026-01-01T00:00:00.000000Z", visibility: "1:1:" };
        }
    );
    expect(read).toBe(true);
    expect(inventory.hosts[0]?.available).toBe(true);
    expect(inventory.hosts[0]?.observationVisibility).toBe("1:1:");
});
