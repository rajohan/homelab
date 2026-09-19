import { expect, test } from "bun:test";

import {
    createApplicationFixture,
    applicationFixtureDetail,
} from "../../testing/applications";
import { expectOperationFailure, operationFixture } from "../../testing/operations";
import { performApplicationAction } from "./actions";
import { createDockerPort, type DockerPort } from "./docker";
import {
    collectApplications,
    filterApplicationInventory,
    mapDockerApplication,
    applicationInventoryByteLimit,
} from "./inventory";
import {
    readApplicationInventory,
    selectionRevision,
    selectApplications,
} from "./selection";

function largeFixtureDetail(id: string) {
    const detail = applicationFixtureDetail(id, "large-metadata");
    detail.Mounts = Array.from({ length: 10 }, () => ({
        Type: "volume",
        Source: "ø".repeat(1000),
        Destination: "/data",
        RW: true,
    }));
    return detail;
}

test.each(["networks", "ports", "bindings", "mounts", "body"] as const)(
    "Docker inspect bounds %s before retaining metadata",
    async (field) => {
        const fixture = createApplicationFixture();
        try {
            const detail = applicationFixtureDetail("a".repeat(64), "bounded");
            if (field === "networks")
                detail.NetworkSettings.Networks = Object.fromEntries(
                    Array.from({ length: 33 }, (_, index) => [`network-${index}`, {}])
                );
            if (field === "ports")
                detail.NetworkSettings.Ports = Object.fromEntries(
                    Array.from({ length: 129 }, (_, index) => [`${index}/tcp`, null])
                );
            if (field === "bindings")
                detail.NetworkSettings.Ports = {
                    "80/tcp": Array.from({ length: 9 }, () => ({
                        HostIp: "127.0.0.1",
                        HostPort: "80",
                    })),
                };
            if (field === "mounts")
                detail.Mounts = Array.from({ length: 65 }, () => ({
                    Type: "volume",
                    Source: "/data",
                    Destination: "/data",
                    RW: true,
                }));
            if (field === "body")
                detail.Config.Labels = {
                    ...detail.Config.Labels,
                    ignored: "x".repeat(512 * 1024),
                };
            fixture.containers.set(detail.Id, detail);
            const port = createDockerPort(fixture.target, {});
            expect(
                await port
                    .inspect(detail.Id, AbortSignal.timeout(3000))
                    .catch((error: unknown) => error)
            ).toBeInstanceOf(Error);
            expect(fixture.calls).toEqual([]);
        } finally {
            await fixture.close();
        }
    }
);

test("container and host metadata byte budgets fail closed without retaining partial projects", async () => {
    const fixture = createApplicationFixture();
    try {
        const detail = largeFixtureDetail("a".repeat(64));
        const oversized = { ...detail, Mounts: [...detail.Mounts, ...detail.Mounts] };
        fixture.containers.set(detail.Id, oversized);
        const port = createDockerPort(fixture.target, {});
        const inspected = await port.inspect(detail.Id, AbortSignal.timeout(3000));
        expect(() => mapDockerApplication(fixture.target, inspected)).toThrow("metadata");
        const retained = mapDockerApplication(fixture.target, detail);
        const largePort: DockerPort = {
            ...port,
            list: () =>
                Promise.resolve(
                    Array.from({ length: 200 }, (_, index) =>
                        index.toString(16).padStart(64, "0")
                    )
                ),
            inspect: (id) => Promise.resolve(largeFixtureDetail(id)),
        };
        const inventory = await collectApplications(
            [fixture.target],
            () => largePort,
            AbortSignal.timeout(3000)
        );
        expect(inventory.hosts[0]).toMatchObject({ available: false, applications: [] });
        for (const applications of [
            Array.from({ length: 201 }, () => retained),
            Array.from({ length: 100 }, () => retained),
            [{ ...retained, networks: ["ø".repeat(20_000)] }],
        ]) {
            const previous = {
                capturedAt: new Date().toISOString(),
                hosts: [
                    {
                        id: fixture.target.id,
                        label: fixture.target.label,
                        available: true,
                        applications,
                    },
                ],
            };
            const snapshot = await collectApplications(
                [fixture.target],
                () => largePort,
                AbortSignal.timeout(3000),
                previous
            );
            expect(snapshot.hosts[0]).toMatchObject({
                available: false,
                applications: [],
            });
            expect(
                filterApplicationInventory(previous, [fixture.target])?.hosts[0]
            ).toMatchObject({ available: false, applications: [] });
        }
    } finally {
        await fixture.close();
    }
});

test("aggregate snapshot budget admits complete hosts only, including unavailable retained hosts", async () => {
    const fixture = createApplicationFixture();
    try {
        const targets = Array.from({ length: 10 }, (_, index) => ({
            ...fixture.target,
            id: `host-${index}`,
        }));
        const port: DockerPort = {
            ...createDockerPort(fixture.target, {}),
            list: () =>
                Promise.resolve(
                    Array.from({ length: 45 }, (_, index) =>
                        index.toString(16).padStart(64, "0")
                    )
                ),
            inspect: (id) => Promise.resolve(largeFixtureDetail(id)),
        };
        const inventory = await collectApplications(
            targets,
            () => port,
            AbortSignal.timeout(5000)
        );
        expect(inventory.hosts.some((host) => host.available)).toBe(true);
        expect(inventory.hosts.some((host) => !host.available)).toBe(true);
        expect(
            new TextEncoder().encode(JSON.stringify(inventory)).byteLength
        ).toBeLessThanOrEqual(applicationInventoryByteLimit);
        for (const host of inventory.hosts)
            expect(host.applications).toHaveLength(host.available ? 45 : 0);
        const retained = await collectApplications(
            targets,
            () => ({ ...port, list: () => Promise.reject(new Error("Unavailable")) }),
            AbortSignal.timeout(5000),
            inventory
        );
        expect(retained.hosts.every((host) => !host.available)).toBe(true);
        expect(
            new TextEncoder().encode(JSON.stringify(retained)).byteLength
        ).toBeLessThanOrEqual(applicationInventoryByteLimit);
        await expectOperationFailure(
            collectApplications(
                [...targets, ...targets, fixture.target],
                () => port,
                AbortSignal.timeout(1000)
            ),
            "Host inventory"
        );
        const oversizedList = await collectApplications(
            [fixture.target],
            () => ({
                ...port,
                list: () =>
                    Promise.resolve(Array.from({ length: 201 }, () => "a".repeat(64))),
            }),
            AbortSignal.timeout(1000)
        );
        expect(oversizedList.hosts[0]).toMatchObject({
            available: false,
            applications: [],
        });
    } finally {
        await fixture.close();
    }
});

test("legacy oversized inventory is rejected in the database before transfer", async () => {
    const fixture = await operationFixture();
    try {
        const inventory = { capturedAt: new Date().toISOString(), hosts: [] };
        await fixture.client`INSERT INTO operation_snapshots(key,value,captured_at) VALUES ('applications.inventory', ${JSON.stringify(inventory)}::text::jsonb,now())`;
        const stored = await readApplicationInventory(fixture.client);
        expect(stored).toMatchObject({ inventory: { hosts: [] }, fresh: true });
        const oversized = JSON.stringify({
            ...inventory,
            legacy: "x".repeat(applicationInventoryByteLimit * 2),
        });
        await fixture.client`UPDATE operation_snapshots SET value=${oversized}::text::jsonb WHERE key='applications.inventory'`;
        expect(await readApplicationInventory(fixture.client)).toBeNull();
    } finally {
        await fixture.close();
    }
});

test.each(["start", "stop", "restart"] as const)(
    "%s revalidates later containers after earlier operations and readiness waits",
    async (operation) => {
        const fixture = createApplicationFixture();
        try {
            const port = createDockerPort(fixture.target, {});
            const details = [...fixture.containers.values()];
            const selection = { kind: "project" as const, target: "demo" };
            const revision = selectionRevision(
                details.map((detail) => mapDockerApplication(fixture.target, detail)),
                selection
            );
            const laterId = (operation === "start" ? "b" : "a").repeat(64);
            const later = fixture.containers.get(laterId);
            if (!later) throw new Error("Missing later fixture container");
            await expectOperationFailure(
                performApplicationAction(
                    fixture.target,
                    port,
                    { selection, revision, operation },
                    AbortSignal.timeout(3000),
                    (message) => {
                        if (
                            message ===
                            (operation === "start"
                                ? "Starting demo-web."
                                : "Stopping demo-database.")
                        )
                            later.State.Health = { Status: "unhealthy" };
                        return Promise.resolve();
                    }
                ),
                "changed"
            );
            expect(fixture.calls).toEqual(
                operation === "start" ? ["start:database"] : ["stop:web"]
            );
        } finally {
            await fixture.close();
        }
    }
);

test("project operations never list or inspect unrelated allowlisted projects", async () => {
    const fixture = createApplicationFixture();
    try {
        const target = { ...fixture.target, projects: ["demo", "unrelated"] };
        const port = createDockerPort(target, {});
        const selection = { kind: "project" as const, target: "demo" };
        const revision = selectionRevision(
            [...fixture.containers.values()].map((detail) =>
                mapDockerApplication(target, detail)
            ),
            selection
        );
        for (let index = 0; index < 200; index += 1) {
            const detail = applicationFixtureDetail(
                (index + 1).toString(16).padStart(64, "0"),
                `unrelated-${index}`
            );
            detail.Config.Labels = {
                ...detail.Config.Labels,
                "com.docker.compose.project": "unrelated",
            };
            fixture.containers.set(detail.Id, detail);
        }
        const signal = AbortSignal.timeout(3000);
        await expectOperationFailure(port.list(signal), "budget");
        await expectOperationFailure(port.list(signal, "not-allowed"), "outside");
        const inspected: string[] = [];
        const scoped: DockerPort = {
            ...port,
            inspect: (id, requestSignal) => {
                inspected.push(id);
                if (!["a".repeat(64), "b".repeat(64)].includes(id))
                    return Promise.reject(new Error("Unrelated container disappeared"));
                return port.inspect(id, requestSignal);
            },
        };
        await performApplicationAction(
            target,
            scoped,
            { selection, revision, operation: "stop" },
            signal
        );
        expect(new Set(inspected)).toEqual(new Set(["a".repeat(64), "b".repeat(64)]));
        expect(fixture.calls).toEqual(["stop:web", "stop:database"]);
    } finally {
        await fixture.close();
    }
});

test("health-only transitions invalidate container and project confirmations before any mutation", async () => {
    const fixture = createApplicationFixture();
    try {
        const detail = fixture.containers.get("a".repeat(64));
        if (!detail) throw new Error("Missing fixture");
        const port = createDockerPort(fixture.target, {});
        for (const selection of [
            { kind: "container" as const, target: detail.Id },
            { kind: "project" as const, target: "demo" },
        ]) {
            detail.State.Health = { Status: "healthy" };
            const inventory = await collectApplications(
                [fixture.target],
                () => port,
                AbortSignal.timeout(3000)
            );
            const revision = selectionRevision(
                selectApplications(inventory, "demo", selection, true),
                selection
            );
            detail.State.Health = { Status: "unhealthy" };
            await expectOperationFailure(
                performApplicationAction(
                    fixture.target,
                    port,
                    { selection, revision, operation: "restart" },
                    AbortSignal.timeout(3000)
                ),
                "changed"
            );
            expect(fixture.calls).toEqual([]);
        }
    } finally {
        await fixture.close();
    }
});

test("discovery isolates slow hosts with individual deadlines and still honors whole-job cancellation", async () => {
    const fixture = createApplicationFixture();
    try {
        const port = createDockerPort(fixture.target, {});
        const targets = [
            ...Array.from({ length: 8 }, (_, index) => ({
                ...fixture.target,
                id: `slow-${index}`,
            })),
            fixture.target,
        ];
        const started: string[] = [];
        const startedAtTimeout: number[] = [];
        const waitUntilAborted = (signal: AbortSignal): Promise<never> =>
            new Promise((_resolve, reject) => {
                signal.throwIfAborted();
                signal.addEventListener(
                    "abort",
                    () => {
                        startedAtTimeout.push(started.length);
                        reject(new Error("Host deadline reached"));
                    },
                    { once: true }
                );
            });
        const connect = (target: typeof fixture.target): DockerPort => {
            started.push(target.id);
            return target.id === "demo"
                ? port
                : {
                      ...port,
                      list: (signal) =>
                          target.id === "slow-0"
                              ? Promise.resolve(["a".repeat(64)])
                              : waitUntilAborted(signal),
                      inspect: (_id, signal) => waitUntilAborted(signal),
                  };
        };
        const snapshot = await collectApplications(
            targets,
            connect,
            AbortSignal.timeout(2000),
            null,
            50
        );
        expect(snapshot.hosts.filter((host) => !host.available)).toHaveLength(8);
        expect(snapshot.hosts.at(-1)).toMatchObject({ id: "demo", available: true });
        expect(snapshot.hosts.at(-1)?.applications).toHaveLength(2);
        expect(startedAtTimeout).toEqual(Array.from({ length: 8 }, () => 9));
        await expectOperationFailure(
            collectApplications(
                targets,
                connect,
                AbortSignal.timeout(20),
                snapshot,
                2000
            ),
            "timed out"
        );
    } finally {
        await fixture.close();
    }
});

test("Docker discovery strips secret fields, retains unavailable identities and reapplies current allowlists", async () => {
    const fixture = createApplicationFixture();
    const signal = AbortSignal.timeout(3000);
    const connect = () => createDockerPort(fixture.target, {});
    try {
        const inventory = await collectApplications([fixture.target], connect, signal);
        expect(inventory.hosts[0]?.applications).toHaveLength(2);
        expect(JSON.stringify(inventory)).not.toContain("PRIVATE_KEY");
        expect(JSON.stringify(inventory)).not.toContain("Labels");
        expect(inventory.hosts[0]?.applications[0]).toMatchObject({
            networks: ["demo_default"],
            ports: [{ container: "8080/tcp", hostPort: "18080" }],
            mounts: [{ readOnly: false }],
        });
        fixture.behavior.unavailable = true;
        const unavailable = await collectApplications(
            [fixture.target],
            connect,
            signal,
            inventory
        );
        expect(unavailable.hosts[0]?.available).toBe(false);
        expect(unavailable.hosts[0]?.applications).toHaveLength(2);
        expect(() =>
            selectApplications(
                unavailable,
                "demo",
                { kind: "project", target: "demo" },
                true
            )
        ).toThrow("unavailable");
        expect(filterApplicationInventory(inventory, [])?.hosts).toEqual([]);
        expect(
            filterApplicationInventory(inventory, [
                { ...fixture.target, projects: ["other"] },
            ])?.hosts[0]?.applications
        ).toEqual([]);
        expect(filterApplicationInventory(null, [fixture.target])).toBeNull();
    } finally {
        await fixture.close();
    }
});

test("project restart stops dependents first, waits for readiness and never retargets stale identities", async () => {
    const fixture = createApplicationFixture(),
        signal = AbortSignal.timeout(3000);
    const port = createDockerPort(fixture.target, {});
    const selection = { kind: "project" as const, target: "demo" };
    const revision = () =>
        selectionRevision(
            [...fixture.containers.values()].map((detail) =>
                mapDockerApplication(fixture.target, detail)
            ),
            selection
        );
    try {
        const intent = { selection, operation: "restart" as const, revision: revision() };
        await performApplicationAction(fixture.target, port, intent, signal);
        expect(fixture.calls).toEqual([
            "stop:web",
            "stop:database",
            "start:database",
            "start:web",
        ]);
        await expectOperationFailure(
            performApplicationAction(fixture.target, port, intent, signal),
            "changed"
        );
        expect(fixture.calls).toHaveLength(4);
        fixture.calls.length = 0;
        await performApplicationAction(
            fixture.target,
            port,
            { ...intent, revision: revision(), operation: "stop" },
            signal
        );
        expect(fixture.calls).toEqual(["stop:web", "stop:database"]);
        fixture.calls.length = 0;
        await performApplicationAction(
            fixture.target,
            port,
            { ...intent, revision: revision(), operation: "start" },
            signal
        );
        expect(fixture.calls).toEqual(["start:database", "start:web"]);
    } finally {
        await fixture.close();
    }
});

test("dependency failures, changed project membership and aborted intents prevent unsafe writes", async () => {
    const fixture = createApplicationFixture(),
        signal = AbortSignal.timeout(3000);
    const port = createDockerPort(fixture.target, {}),
        selection = { kind: "project" as const, target: "demo" };
    const revision = () =>
        selectionRevision(
            [...fixture.containers.values()].map((detail) =>
                mapDockerApplication(fixture.target, detail)
            ),
            selection
        );
    try {
        const database = fixture.containers.get("a".repeat(64)),
            web = fixture.containers.get("b".repeat(64));
        if (!database || !web) throw new Error("Missing fixture");
        database.Config.Labels = {
            ...database.Config.Labels,
            "com.docker.compose.depends_on": "web:service_started:false",
        };
        await expectOperationFailure(
            performApplicationAction(
                fixture.target,
                port,
                { selection, revision: revision(), operation: "start" },
                signal
            ),
            "cycle"
        );
        expect(fixture.calls).toEqual([]);
        delete database.Config.Labels["com.docker.compose.depends_on"];
        database.State.Health = { Status: "unhealthy" };
        await expectOperationFailure(
            performApplicationAction(
                fixture.target,
                port,
                { selection, revision: revision(), operation: "start" },
                signal
            ),
            "ready"
        );
        expect(fixture.calls).toEqual(["start:database"]);
        fixture.calls.length = 0;
        web.Config.Labels = {
            ...web.Config.Labels,
            "com.docker.compose.project": "outside",
        };
        await expectOperationFailure(port.inspect(web.Id, signal), "outside");
        await expectOperationFailure(
            performApplicationAction(
                fixture.target,
                port,
                { selection, revision: revision(), operation: "stop" },
                signal
            ),
            "changed"
        );
        expect(fixture.calls).toEqual([]);
        for (const option of ["redirect", "large", "unavailable"] as const) {
            fixture.behavior[option] = true;
            const failure = await port.list(signal).catch((error: unknown) => error);
            expect(failure).toBeInstanceOf(Error);
            expect(String(failure)).not.toContain("private provider");
            fixture.behavior[option] = false;
        }
        expect(() =>
            createDockerPort(
                { ...fixture.target, tls: { ca: "A", certificate: "B", key: "C" } },
                {}
            )
        ).toThrow("credentials");
    } finally {
        await fixture.close();
    }
});
