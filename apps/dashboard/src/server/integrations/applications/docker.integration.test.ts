import { expect, test } from "bun:test";

import {
    createApplicationFixture,
    applicationFixtureDetail,
} from "../../testing/applications";
import { expectOperationFailure, operationFixture } from "../../testing/operations";
import { hasApplicationCodeMount } from "../updates/observations";
import { performApplicationAction } from "./actions";
import { waitForApplicationReady } from "./dependencies";
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

test.each([
    { test: ["CMD", "/custom/check", "SYNTHETIC_PRIVATE"], blocked: true },
    {
        test: ["CMD-SHELL", "/vendor/prep; /custom/check --token=SYNTHETIC_PRIVATE"],
        blocked: true,
    },
    { test: ["CMD-SHELL", '/vendor/check "$(/custom/check)"'], blocked: true },
    { test: ["CMD-SHELL", "( /custom/check )"], blocked: true },
    { test: ["CMD-SHELL", "{ /custom/check; }"], blocked: true },
    { test: ["CMD-SHELL", "if /custom/check; then true; fi"], blocked: true },
    { test: ["CMD-SHELL", "/vendor/check '( /custom/data )'"], blocked: false },
    { test: ["CMD-SHELL", "command /custom/check"], blocked: true },
    { test: ["CMD-SHELL", "command -p -- /custom/check"], blocked: true },
    { test: ["CMD-SHELL", "builtin command /custom/check"], blocked: true },
    { test: ["CMD-SHELL", "command cd /custom; ./check"], blocked: true },
    { test: ["CMD-SHELL", "command -v /custom/check"], blocked: false },
    { test: ["CMD-SHELL", "command -pV /custom/check"], blocked: false },
    { test: ["CMD", "nice", "-n", "5", "/custom/check"], blocked: true },
    { test: ["CMD-SHELL", "nohup timeout 5s /custom/check"], blocked: true },
    { test: ["CMD", "bash", "-O", "extglob", "/custom/check"], blocked: true },
    { test: ["CMD-SHELL", "trap /custom/check EXIT; true"], blocked: true },
    { test: ["CMD", "java", "-jar", "/custom/app.jar"], blocked: true },
    { test: ["CMD-SHELL", "env LD_PRELOAD=/custom/lib.so /vendor/check"], blocked: true },
    { test: ["CMD", "nice", "/vendor/check", "/custom/config"], blocked: false },
    { test: ["CMD", "/vendor/check", "--data", "/custom/config"], blocked: false },
    { test: ["NONE", "/custom/check"], blocked: false },
])(
    "Docker healthcheck commands are qualified without publishing argv: %j",
    async (scenario) => {
        const fixture = createApplicationFixture();
        try {
            const detail = fixture.containers.get("a".repeat(64))!;
            detail.Config.Entrypoint = ["/vendor/server"];
            detail.Config.Cmd = [];
            detail.Config.Healthcheck = { Test: [...scenario.test] };
            detail.Mounts = [
                {
                    Type: "volume",
                    Source: "fixture-code",
                    Destination: "/custom",
                    RW: false,
                },
            ];
            const port = createDockerPort(fixture.target, {});
            const inspected = await port.inspect(detail.Id, AbortSignal.timeout(3000));
            const mapped = mapDockerApplication(fixture.target, inspected);
            expect(hasApplicationCodeMount(mapped)).toBe(scenario.blocked);
            expect(JSON.stringify(mapped)).not.toContain("SYNTHETIC_PRIVATE");
            expect(mapped).not.toHaveProperty("Healthcheck");
        } finally {
            await fixture.close();
        }
    }
);

test.each([
    ["LD_PRELOAD", true],
    ["LD_LIBRARY_PATH", true],
    ["BASH_ENV", true],
    ["NODE_OPTIONS", true],
    ["CLASSPATH", true],
    ["APP_CONFIG", false],
] as const)(
    "Docker loader environment %s is private and qualified",
    async (name, blocked) => {
        const fixture = createApplicationFixture();
        try {
            const detail = fixture.containers.get("a".repeat(64))!;
            detail.Config.Entrypoint = ["/vendor/server"];
            detail.Config.Cmd = [];
            detail.Config.Env = [name + "=/custom/SYNTHETIC_PRIVATE"];
            detail.Mounts = [
                {
                    Type: "volume",
                    Source: "fixture-code",
                    Destination: "/custom",
                    RW: false,
                },
            ];
            const inventory = await collectApplications(
                [fixture.target],
                () => createDockerPort(fixture.target, {}),
                AbortSignal.timeout(3000)
            );
            const app = inventory.hosts[0]!.applications.find(
                (value) => value.containerId === detail.Id
            )!;
            expect(hasApplicationCodeMount(app)).toBe(blocked);
            expect(JSON.stringify(inventory)).not.toContain("SYNTHETIC_PRIVATE");
            expect(
                JSON.stringify(filterApplicationInventory(inventory, [fixture.target]))
            ).not.toContain("SYNTHETIC_PRIVATE");
        } finally {
            await fixture.close();
        }
    }
);

test("oversized internal visibility still produces a readable healthy PostgreSQL snapshot", async () => {
    const fixture = await operationFixture();
    const docker = createApplicationFixture();
    try {
        const inventory = await collectApplications(
            [docker.target],
            () => createDockerPort(docker.target, {}),
            AbortSignal.timeout(3000),
            undefined,
            2000,
            () =>
                Promise.resolve({
                    time: new Date().toISOString(),
                    visibility: "1:999999:" + "2,".repeat(applicationInventoryByteLimit),
                })
        );
        expect(inventory.hosts[0]?.available).toBe(true);
        expect(inventory.hosts[0]?.applications.length).toBeGreaterThan(0);
        expect(inventory.hosts[0]).not.toHaveProperty("observationVisibility");
        await fixture.client`INSERT INTO operation_snapshots(key,value,captured_at) VALUES ('applications.inventory', ${JSON.stringify(inventory)}::text::jsonb, now())`;
        const stored = await readApplicationInventory(fixture.client);
        expect(stored?.inventory.hosts).toEqual(inventory.hosts);
    } finally {
        await docker.close();
        await fixture.close();
    }
});

test.each(["NetworkMode", "PidMode", "IpcMode"] as const)(
    "%s late starts of preserved consumers fail before provider mutation",
    async (namespace) => {
        for (const status of ["created", "exited"] as const) {
            for (const operation of ["stop", "restart"] as const) {
                const fixture = createApplicationFixture();
                try {
                    const provider = fixture.containers.get("a".repeat(64))!;
                    const consumer = fixture.containers.get("b".repeat(64))!;
                    consumer.HostConfig[namespace] = `container:${provider.Id}`;
                    consumer.State.Status = status;
                    const port = createDockerPort(fixture.target, {});
                    const signal = AbortSignal.timeout(3000);
                    const selection = { kind: "container" as const, target: provider.Id };
                    const inventory = await collectApplications(
                        [fixture.target],
                        () => port,
                        signal
                    );
                    const revision = selectionRevision(
                        selectApplications(inventory, fixture.target.id, selection, true),
                        selection
                    );
                    const before = provider.State.StartedAt;
                    let changed = false;
                    await expectOperationFailure(
                        performApplicationAction(
                            fixture.target,
                            port,
                            { selection, revision, operation },
                            signal,
                            (message) => {
                                if (!changed && message.startsWith("Stopping")) {
                                    changed = true;
                                    consumer.State.Status = "running";
                                    consumer.State.StartedAt = "2026-09-01T11:00:00Z";
                                }
                                return Promise.resolve();
                            }
                        ),
                        "preserved container changed"
                    );
                    expect(changed).toBe(true);
                    expect(fixture.calls).toEqual([]);
                    expect(provider.State.StartedAt).toBe(before);
                    expect(consumer.State.Status).toBe("running");
                    const current = await collectApplications(
                        [fixture.target],
                        () => port,
                        signal
                    );
                    await performApplicationAction(
                        fixture.target,
                        port,
                        {
                            selection,
                            operation,
                            revision: selectionRevision(
                                selectApplications(
                                    current,
                                    fixture.target.id,
                                    selection,
                                    true
                                ),
                                selection
                            ),
                        },
                        signal
                    );
                    expect(fixture.calls).toEqual(
                        operation === "stop"
                            ? ["stop:web", "stop:database"]
                            : ["stop:web", "stop:database", "start:database", "start:web"]
                    );
                } finally {
                    await fixture.close();
                }
            }
        }
    }
);

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

test.each(["NetworkMode", "PidMode", "IpcMode"] as const)(
    "%s start refuses mixed running consumers and stopped providers before any write",
    async (kind) => {
        const fixture = createApplicationFixture();
        try {
            const provider = fixture.containers.get("a".repeat(64))!;
            const consumer = fixture.containers.get("b".repeat(64))!;
            consumer.HostConfig[kind] = `container:${provider.Id}`;
            provider.State.Status = "exited";
            const port = createDockerPort(fixture.target, {});
            for (const selection of [
                { kind: "container" as const, target: provider.Id },
                { kind: "project" as const, target: "demo" },
            ]) {
                const inventory = await collectApplications(
                    [fixture.target],
                    () => port,
                    AbortSignal.timeout(3000)
                );
                const revision = selectionRevision(
                    selectApplications(inventory, "demo", selection, true),
                    selection
                );
                await expectOperationFailure(
                    performApplicationAction(
                        fixture.target,
                        port,
                        { selection, revision, operation: "start" },
                        AbortSignal.timeout(3000)
                    ),
                    "stopped shared namespace provider"
                );
                expect(fixture.calls).toEqual([]);
                expect(provider.State.Status).toBe("exited");
                expect(consumer.State.StartedAt).toBe("2026-09-01T10:00:00Z");
            }
            consumer.State.Status = "exited";
            const selection = { kind: "project" as const, target: "demo" };
            const inventory = await collectApplications(
                [fixture.target],
                () => port,
                AbortSignal.timeout(3000)
            );
            await performApplicationAction(
                fixture.target,
                port,
                {
                    selection,
                    revision: selectionRevision(
                        selectApplications(inventory, "demo", selection, true),
                        selection
                    ),
                    operation: "start",
                },
                AbortSignal.timeout(3000)
            );
            expect(fixture.calls).toEqual(["start:database", "start:web"]);
        } finally {
            await fixture.close();
        }
    }
);

test.each(["NetworkMode", "PidMode", "IpcMode"] as const)(
    "%s project actions reject external namespace consumers initially and at revalidation",
    async (kind) => {
        for (const operation of ["start", "stop", "restart"] as const)
            for (const late of [false, true]) {
                const fixture = createApplicationFixture();
                try {
                    const target = { ...fixture.target, projects: ["demo", "other"] };
                    const port = createDockerPort(target, {});
                    const provider = fixture.containers.get("a".repeat(64))!;
                    const selection = { kind: "project" as const, target: "demo" };
                    const inventory = await collectApplications(
                        [target],
                        () => port,
                        AbortSignal.timeout(3000)
                    );
                    const revision = selectionRevision(
                        selectApplications(inventory, "demo", selection, true),
                        selection
                    );
                    const foreign = applicationFixtureDetail("c".repeat(64), "foreign");
                    foreign.Config.Labels!["com.docker.compose.project"] = "other";
                    foreign.HostConfig[kind] = `container:${provider.Id}`;
                    if (!late) fixture.containers.set(foreign.Id, foreign);
                    const observed: DockerPort = {
                        ...port,
                        inspect: async (id, signal) => {
                            const detail = await port.inspect(id, signal);
                            if (late) fixture.containers.set(foreign.Id, foreign);
                            return detail;
                        },
                    };
                    await expectOperationFailure(
                        performApplicationAction(
                            target,
                            observed,
                            { selection, revision, operation },
                            AbortSignal.timeout(3000)
                        ),
                        "project boundaries"
                    );
                    expect(fixture.calls).toEqual([]);
                    expect(provider.State.StartedAt).toBe("2026-09-01T10:00:00Z");
                } finally {
                    await fixture.close();
                }
            }
    }
);

test.each([
    ["service_started", "exited", "healthy", 0, false],
    ["service_healthy", "running", "unhealthy", 0, false],
    ["service_completed_successfully", "exited", "healthy", 1, false],
    ["service_started", "running", "unhealthy", 0, true],
    ["service_healthy", "running", "healthy", 0, true],
    ["service_completed_successfully", "exited", "healthy", 0, true],
] as const)(
    "namespace restart preflights external %s dependency in %s/%s with exit %s",
    async (condition, status, health, exitCode, allowed) => {
        const fixture = createApplicationFixture();
        try {
            const provider = fixture.containers.get("a".repeat(64))!;
            const consumer = fixture.containers.get("b".repeat(64))!;
            consumer.HostConfig.NetworkMode = `container:${provider.Id}`;
            consumer.Config.Labels!["com.docker.compose.depends_on"] =
                `external:${condition}:false`;
            const external = applicationFixtureDetail("c".repeat(64), "external");
            external.State.Status = status;
            external.State.Health = { Status: health };
            external.State.ExitCode = exitCode;
            fixture.containers.set(external.Id, external);
            const port = createDockerPort(fixture.target, {});
            const selection = { kind: "container" as const, target: provider.Id };
            const inventory = await collectApplications(
                [fixture.target],
                () => port,
                AbortSignal.timeout(3000)
            );
            const revision = selectionRevision(
                selectApplications(inventory, "demo", selection, true),
                selection
            );
            const result = performApplicationAction(
                fixture.target,
                port,
                { selection, revision, operation: "restart" },
                AbortSignal.timeout(3000)
            );
            if (allowed) {
                await result;
                expect(fixture.calls).toEqual([
                    "stop:web",
                    "stop:database",
                    "start:database",
                    "start:web",
                ]);
            } else {
                await expectOperationFailure(result, "dependency did not become ready");
                expect(fixture.calls).toEqual([]);
                expect(provider.State.StartedAt).toBe("2026-09-01T10:00:00Z");
                expect(consumer.State.StartedAt).toBe("2026-09-01T10:00:00Z");
            }
            expect(external.State.Status).toBe(status);
        } finally {
            await fixture.close();
        }
    }
);

test.each([
    "add-same",
    "add-other",
    "remove-same",
    "remove-other",
    "vanishing-addition",
    "new-consumer",
    "replaced-consumer",
    "cross-project-consumer",
] as const)(
    "container restart fences only its coordinated namespace group during %s",
    async (change) => {
        const fixture = createApplicationFixture();
        try {
            const target = { ...fixture.target, projects: ["demo", "other"] };
            const provider = fixture.containers.get("a".repeat(64))!;
            const consumer = fixture.containers.get("b".repeat(64))!;
            consumer.HostConfig.NetworkMode = `container:${provider.Id}`;
            const unrelated = applicationFixtureDetail("d".repeat(64), "unrelated");
            if (change.endsWith("other"))
                unrelated.Config.Labels!["com.docker.compose.project"] = "other";
            fixture.containers.set(unrelated.Id, unrelated);
            const port = createDockerPort(target, {});
            const inventory = await collectApplications(
                [target],
                () => port,
                AbortSignal.timeout(3000)
            );
            const selection = { kind: "container" as const, target: provider.Id };
            const revision = selectionRevision(
                selectApplications(inventory, target.id, selection, true),
                selection
            );
            const added = applicationFixtureDetail("e".repeat(64), "added");
            if (change === "add-other" || change === "cross-project-consumer")
                added.Config.Labels!["com.docker.compose.project"] = "other";
            if (change.includes("consumer"))
                added.HostConfig.NetworkMode = `container:${provider.Id}`;
            const changing: DockerPort = {
                ...port,
                inspect: async (id, signal) => {
                    if (id === added.Id && change === "vanishing-addition")
                        fixture.containers.delete(id);
                    return port.inspect(id, signal);
                },
                act: async (id, operation, signal) => {
                    await port.act(id, operation, signal);
                    if (fixture.calls.length !== 1) return;
                    if (change.startsWith("remove-"))
                        fixture.containers.delete(unrelated.Id);
                    else fixture.containers.set(added.Id, added);
                    if (change === "replaced-consumer")
                        fixture.containers.delete(consumer.Id);
                },
            };
            const result = performApplicationAction(
                target,
                changing,
                { selection, revision, operation: "restart" },
                AbortSignal.timeout(3000)
            );
            if (change.includes("consumer")) {
                await expectOperationFailure(
                    result,
                    change === "cross-project-consumer"
                        ? "project boundaries"
                        : "membership changed"
                );
                expect(fixture.calls).toEqual(["stop:web"]);
            } else {
                await result;
                expect(fixture.calls).toEqual([
                    "stop:web",
                    "stop:database",
                    "start:database",
                    "start:web",
                ]);
                expect(provider.State.Status).toBe("running");
                expect(consumer.State.Status).toBe("running");
            }
        } finally {
            await fixture.close();
        }
    }
);

test.each(["NetworkMode", "PidMode", "IpcMode"] as const)(
    "%s provider restart coordinates the confirmed namespace group",
    async (kind) => {
        const fixture = createApplicationFixture();
        try {
            const provider = fixture.containers.get("a".repeat(64))!;
            const consumer = fixture.containers.get("b".repeat(64))!;
            consumer.HostConfig = {
                NetworkMode: "",
                PidMode: "",
                IpcMode: "",
                [kind]: `container:${provider.Id}`,
            };
            const port = createDockerPort(fixture.target, {});
            const inventory = await collectApplications(
                [fixture.target],
                () => port,
                AbortSignal.timeout(3000)
            );
            const selection = { kind: "container" as const, target: provider.Id };
            const selected = selectApplications(inventory, "demo", selection, true);
            expect(selected).toHaveLength(2);
            const revision = selectionRevision(selected, selection);
            expect(revision).not.toBe(selected[0]!.revision);
            await performApplicationAction(
                fixture.target,
                port,
                { selection, revision, operation: "restart" },
                AbortSignal.timeout(3000)
            );
            expect(fixture.calls).toEqual([
                "stop:web",
                "stop:database",
                "start:database",
                "start:web",
            ]);
        } finally {
            await fixture.close();
        }
    }
);

test.each(["NetworkMode", "PidMode", "IpcMode"] as const)(
    "%s restart rejects a stopped intermediate before disrupting a running descendant",
    async (kind) => {
        const fixture = createApplicationFixture();
        try {
            const root = fixture.containers.get("a".repeat(64))!;
            const intermediate = fixture.containers.get("b".repeat(64))!;
            const leaf = applicationFixtureDetail("c".repeat(64), "leaf");
            intermediate.HostConfig[kind] = `container:${root.Id}`;
            leaf.HostConfig[kind] = `container:${intermediate.Id}`;
            fixture.containers.set(leaf.Id, leaf);
            const port = createDockerPort(fixture.target, {});
            const selection = { kind: "container" as const, target: root.Id };
            const run = async () => {
                const inventory = await collectApplications(
                    [fixture.target],
                    () => port,
                    AbortSignal.timeout(3000)
                );
                const revision = selectionRevision(
                    selectApplications(inventory, "demo", selection, true),
                    selection
                );
                return performApplicationAction(
                    fixture.target,
                    port,
                    { selection, revision, operation: "restart" },
                    AbortSignal.timeout(3000)
                );
            };
            for (const state of ["exited", "created"]) {
                intermediate.State.Status = state;
                await expectOperationFailure(run(), "namespace");
                expect(fixture.calls).toEqual([]);
                expect(leaf.State.Status).toBe("running");
                expect(root.State.StartedAt).toBe("2026-09-01T10:00:00Z");
            }
            leaf.State.Status = "exited";
            await run();
            expect(fixture.calls).toEqual(["stop:database", "start:database"]);
            expect(intermediate.State.Status).toBe("created");
            expect(leaf.State.Status).toBe("exited");
            fixture.calls.length = 0;
            const project = { kind: "project" as const, target: "demo" };
            const inventory = await collectApplications(
                [fixture.target],
                () => port,
                AbortSignal.timeout(3000)
            );
            const revision = selectionRevision(
                selectApplications(inventory, "demo", project, true),
                project
            );
            await performApplicationAction(
                fixture.target,
                port,
                { selection: project, revision, operation: "start" },
                AbortSignal.timeout(3000)
            );
            expect(fixture.calls).toEqual(["start:database", "start:web", "start:leaf"]);
            expect(intermediate.State.Status).toBe("running");
            expect(leaf.State.Status).toBe("running");
        } finally {
            await fixture.close();
        }
    }
);

test.each(["start", "restart"] as const)(
    "%s refuses a missing immutable namespace before any mutation",
    async (operation) => {
        const fixture = createApplicationFixture();
        try {
            const consumer = fixture.containers.get("b".repeat(64))!;
            consumer.HostConfig = {
                NetworkMode: `container:${"f".repeat(64)}`,
                PidMode: "",
                IpcMode: "",
            };
            const port = createDockerPort(fixture.target, {});
            const selection = { kind: "container" as const, target: consumer.Id };
            const revision = mapDockerApplication(fixture.target, consumer).revision;
            const progress: string[] = [];
            await expectOperationFailure(
                performApplicationAction(
                    fixture.target,
                    port,
                    { selection, revision, operation },
                    AbortSignal.timeout(3000),
                    (message) => {
                        progress.push(message);
                        return Promise.resolve();
                    }
                ),
                "namespace"
            );
            expect(fixture.calls).toEqual([]);
            expect(
                progress.some((message) => message.includes("No containers were changed"))
            ).toBe(true);
        } finally {
            await fixture.close();
        }
    }
);

test("namespace impact changes invalidate individual confirmation and preserve stopped consumers", async () => {
    const fixture = createApplicationFixture();
    try {
        const provider = fixture.containers.get("a".repeat(64))!;
        const consumer = fixture.containers.get("b".repeat(64))!;
        const port = createDockerPort(fixture.target, {});
        const selection = { kind: "container" as const, target: provider.Id };
        const revision = mapDockerApplication(fixture.target, provider).revision;
        consumer.HostConfig = {
            NetworkMode: `container:${provider.Id}`,
            PidMode: "",
            IpcMode: "",
        };
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
        consumer.State.Status = "exited";
        const inventory = await collectApplications(
            [fixture.target],
            () => port,
            AbortSignal.timeout(3000)
        );
        const current = selectionRevision(
            selectApplications(inventory, "demo", selection, true),
            selection
        );
        await performApplicationAction(
            fixture.target,
            port,
            { selection, revision: current, operation: "restart" },
            AbortSignal.timeout(3000)
        );
        expect(fixture.calls).toEqual(["stop:database", "start:database"]);
        expect(consumer.State.Status).toBe("exited");
    } finally {
        await fixture.close();
    }
});

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

test("a container added during initial inspection invalidates the project action before any write", async () => {
    const fixture = createApplicationFixture();
    try {
        const port = createDockerPort(fixture.target, {});
        const selection = { kind: "project" as const, target: "demo" };
        const revision = selectionRevision(
            [...fixture.containers.values()].map((detail) =>
                mapDockerApplication(fixture.target, detail)
            ),
            selection
        );
        const changed: DockerPort = {
            ...port,
            inspect: async (id, signal) => {
                const detail = await port.inspect(id, signal);
                const added = applicationFixtureDetail("e".repeat(64), "added");
                fixture.containers.set(added.Id, added);
                return detail;
            },
        };
        await expectOperationFailure(
            performApplicationAction(
                fixture.target,
                changed,
                { selection, revision, operation: "stop" },
                AbortSignal.timeout(3000)
            ),
            "membership changed"
        );
        expect(fixture.calls).toEqual([]);
    } finally {
        await fixture.close();
    }
});

test.each(["start", "stop", "restart"] as const)(
    "%s stops remaining mutations when project membership changes after preceding work",
    async (operation) => {
        const fixture = createApplicationFixture();
        try {
            const port = createDockerPort(fixture.target, {});
            const selection = { kind: "project" as const, target: "demo" };
            const revision = selectionRevision(
                [...fixture.containers.values()].map((detail) =>
                    mapDockerApplication(fixture.target, detail)
                ),
                selection
            );
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
                        ) {
                            const added = applicationFixtureDetail(
                                "e".repeat(64),
                                "added"
                            );
                            fixture.containers.set(added.Id, added);
                        }
                        return Promise.resolve();
                    }
                ),
                "membership changed"
            );
            expect(fixture.calls).toEqual(
                operation === "start" ? ["start:database"] : ["stop:web"]
            );
        } finally {
            await fixture.close();
        }
    }
);

test("project restart rechecks membership even before restarting already-stopped members", async () => {
    const fixture = createApplicationFixture();
    try {
        const port = createDockerPort(fixture.target, {});
        const selection = { kind: "project" as const, target: "demo" };
        const revision = selectionRevision(
            [...fixture.containers.values()].map((detail) =>
                mapDockerApplication(fixture.target, detail)
            ),
            selection
        );
        await expectOperationFailure(
            performApplicationAction(
                fixture.target,
                port,
                { selection, revision, operation: "restart" },
                AbortSignal.timeout(3000),
                (message) => {
                    if (message === "Starting demo-database.") {
                        fixture.containers.delete("b".repeat(64));
                        const replacement = applicationFixtureDetail(
                            "e".repeat(64),
                            "web"
                        );
                        fixture.containers.set(replacement.Id, replacement);
                    }
                    return Promise.resolve();
                }
            ),
            "membership changed"
        );
        expect(fixture.calls).toEqual(["stop:web", "stop:database"]);
    } finally {
        await fixture.close();
    }
});

test("project membership comparison ignores listing order but catches additions during the final call", async () => {
    const fixture = createApplicationFixture();
    try {
        const port = createDockerPort(fixture.target, {});
        const selection = { kind: "project" as const, target: "demo" };
        const revision = selectionRevision(
            [...fixture.containers.values()].map((detail) =>
                mapDockerApplication(fixture.target, detail)
            ),
            selection
        );
        let listings = 0;
        const reordered: DockerPort = {
            ...port,
            list: async (signal, project) => {
                const ids = await port.list(signal, project);
                listings += 1;
                return listings % 2 === 0 ? ids.toReversed() : ids;
            },
            act: async (id, operation, signal) => {
                await port.act(id, operation, signal);
                if (fixture.calls.length === 2) {
                    const added = applicationFixtureDetail("e".repeat(64), "added");
                    fixture.containers.set(added.Id, added);
                }
            },
        };
        await expectOperationFailure(
            performApplicationAction(
                fixture.target,
                reordered,
                { selection, revision, operation: "stop" },
                AbortSignal.timeout(3000)
            ),
            "membership changed"
        );
        expect(fixture.calls).toEqual(["stop:web", "stop:database"]);
        expect(listings).toBe(4);
    } finally {
        await fixture.close();
    }
});

test.each(["success", "nonzero", "dead"] as const)(
    "completion-only dependencies ignore transient unhealthy state and honor %s terminal status",
    async (outcome) => {
        const fixture = createApplicationFixture();
        try {
            const database = fixture.containers.get("a".repeat(64));
            const web = fixture.containers.get("b".repeat(64));
            if (!database || !web) throw new Error("Missing dependency fixture");
            database.State.Health = { Status: "unhealthy" };
            web.Config.Labels = {
                ...web.Config.Labels,
                "com.docker.compose.depends_on":
                    "database:service_completed_successfully:false",
            };
            const port = createDockerPort(fixture.target, {});
            const selection = { kind: "project" as const, target: "demo" };
            const revision = selectionRevision(
                [...fixture.containers.values()].map((detail) =>
                    mapDockerApplication(fixture.target, detail)
                ),
                selection
            );
            let unhealthyReads = 0;
            const completing: DockerPort = {
                ...port,
                inspect: async (id, signal) => {
                    const current = await port.inspect(id, signal);
                    if (
                        id === database.Id &&
                        fixture.calls.length > 0 &&
                        current.State.Status === "running"
                    ) {
                        unhealthyReads += 1;
                        database.State.Status = outcome === "dead" ? "dead" : "exited";
                        database.State.ExitCode = outcome === "nonzero" ? 1 : 0;
                    }
                    return current;
                },
            };
            const operation = performApplicationAction(
                fixture.target,
                completing,
                { selection, revision, operation: "start" },
                AbortSignal.timeout(3000)
            );
            await (outcome === "success"
                ? operation
                : expectOperationFailure(operation, "did not become ready"));
            expect(unhealthyReads).toBe(1);
            expect(fixture.calls).toEqual(
                outcome === "success"
                    ? ["start:database", "start:web"]
                    : ["start:database"]
            );
        } finally {
            await fixture.close();
        }
    }
);

test.each(["exited", "dead"] as const)(
    "a healthy dependency must still be running rather than %s",
    async (status) => {
        const fixture = createApplicationFixture();
        try {
            const database = fixture.containers.get("a".repeat(64));
            if (!database) throw new Error("Missing dependency fixture");
            const port = createDockerPort(fixture.target, {});
            const selection = { kind: "project" as const, target: "demo" };
            const revision = selectionRevision(
                [...fixture.containers.values()].map((detail) =>
                    mapDockerApplication(fixture.target, detail)
                ),
                selection
            );
            const terminated: DockerPort = {
                ...port,
                inspect: (id, signal) => {
                    if (id === database.Id && fixture.calls.length > 0)
                        database.State.Status = status;
                    return port.inspect(id, signal);
                },
            };
            await expectOperationFailure(
                performApplicationAction(
                    fixture.target,
                    terminated,
                    { selection, revision, operation: "start" },
                    AbortSignal.timeout(3000)
                ),
                "did not become ready"
            );
            expect(fixture.calls).toEqual(["start:database"]);
        } finally {
            await fixture.close();
        }
    }
);

test.each(["healthy", "unhealthy"] as const)(
    "final completion readiness waits for exit even while a one-shot is %s",
    async (health) => {
        const fixture = createApplicationFixture();
        try {
            const item = fixture.containers.get("a".repeat(64));
            if (!item) throw new Error("Missing completion fixture");
            item.State.Health = { Status: health };
            const port = createDockerPort(fixture.target, {});
            let inspections = 0;
            const completing: DockerPort = {
                ...port,
                inspect: async (id, signal) => {
                    const current = await port.inspect(id, signal);
                    inspections += 1;
                    item.State.Status = "exited";
                    return current;
                },
            };
            const messages: string[] = [];
            await waitForApplicationReady(
                item,
                completing,
                AbortSignal.timeout(3000),
                (message) => {
                    messages.push(message);
                    return Promise.resolve();
                },
                true
            );
            expect(inspections).toBe(2);
            expect(messages).toEqual([
                "Waiting for demo-database to complete successfully.",
            ]);
        } finally {
            await fixture.close();
        }
    }
);

test.each(
    (["start", "restart"] as const).flatMap((operation) =>
        (
            ["exited", "unhealthy", "completion restarted", "completion failed"] as const
        ).map((regression) => [operation, regression] as const)
    )
)(
    "%s rejects an earlier %s service after a later service finishes initializing",
    async (operation, regression) => {
        const fixture = createApplicationFixture();
        try {
            const database = fixture.containers.get("a".repeat(64));
            const web = fixture.containers.get("b".repeat(64));
            if (!database || !web) throw new Error("Missing readiness fixture");
            const completed = regression.startsWith("completion");
            if (completed)
                web.Config.Labels = {
                    ...web.Config.Labels,
                    "com.docker.compose.depends_on":
                        "database:service_completed_successfully:false",
                };
            const port = createDockerPort(fixture.target, {});
            const selection = { kind: "project" as const, target: "demo" };
            const revision = selectionRevision(
                [...fixture.containers.values()].map((detail) =>
                    mapDockerApplication(fixture.target, detail)
                ),
                selection
            );
            let waitingForWeb = false;
            const regressing: DockerPort = {
                ...port,
                act: async (id, action, signal) => {
                    await port.act(id, action, signal);
                    if (id === database.Id && action === "start" && completed)
                        database.State.Status = "exited";
                },
                inspect: async (id, signal) => {
                    const current = await port.inspect(id, signal);
                    if (
                        waitingForWeb &&
                        id === web.Id &&
                        current.State.Health?.Status === "starting"
                    ) {
                        database.State.Status =
                            regression === "exited" || regression === "completion failed"
                                ? "exited"
                                : "running";
                        database.State.ExitCode = 1;
                        database.State.Health = {
                            Status: regression === "unhealthy" ? "unhealthy" : "healthy",
                        };
                        web.State.Health = { Status: "healthy" };
                    }
                    return current;
                },
            };
            const messages: string[] = [];
            await expectOperationFailure(
                performApplicationAction(
                    fixture.target,
                    regressing,
                    { selection, revision, operation },
                    AbortSignal.timeout(3000),
                    (message) => {
                        messages.push(message);
                        if (message === "Waiting for demo-web to become healthy.") {
                            waitingForWeb = true;
                            web.State.Health = { Status: "starting" };
                        }
                        return Promise.resolve();
                    }
                ),
                "no longer meets the requested state"
            );
            expect(waitingForWeb).toBe(true);
            expect(web.State.Health?.Status).toBe("healthy");
            expect(messages).not.toContain(
                "All selected containers reached the requested state."
            );
            expect(fixture.calls).toEqual(
                operation === "restart"
                    ? ["stop:web", "stop:database", "start:database", "start:web"]
                    : ["start:database", "start:web"]
            );
        } finally {
            await fixture.close();
        }
    }
);

test("project operations refuse an inventory too large to exclude external namespace consumers", async () => {
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
        await expectOperationFailure(
            performApplicationAction(
                target,
                scoped,
                { selection, revision, operation: "stop" },
                signal
            ),
            "budget"
        );
        expect(inspected).toEqual([]);
        expect(fixture.calls).toEqual([]);
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
