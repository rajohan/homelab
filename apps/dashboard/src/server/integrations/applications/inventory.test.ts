import { expect, test } from "bun:test";

import { collectApplications } from "./inventory";

const target = {
    id: "main",
    label: "Main",
    endpoint: "http://fixture.invalid:2375",
    projects: ["demo"],
};

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
