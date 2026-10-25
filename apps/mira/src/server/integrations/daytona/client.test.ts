import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";

import { DaytonaClient, DaytonaUncertainMutation } from "./client";
import {
    daytonaBinding,
    daytonaBindingHash,
    daytonaConfiguration,
    daytonaPolicy,
    daytonaSandboxName,
} from "./configuration";

const configuration = {
    trustBoundary: "dedicated-organization" as const,
    networkAccess: "provider-default" as const,
    owner: "operator",
    organizationId: "11111111-1111-4111-8111-111111111111",
    snapshotId: "22222222-2222-4222-8222-222222222222",
    target: "eu",
    apiKey: "synthetic-provider-key",
};
const runId = "33333333-3333-4333-8333-333333333333";
const sandboxId = "44444444-4444-4444-8444-444444444444";
const otherId = "55555555-5555-4555-8555-555555555555";
const signal = new AbortController().signal;
const key = {
    userId: "daytona-operator",
    organizationId: configuration.organizationId,
    permissions: ["write:sandboxes", "delete:sandboxes"],
    expiresAt: null,
};
const snapshot = {
    id: configuration.snapshotId,
    name: "qualified-bun-1-4-4",
    organizationId: configuration.organizationId,
    general: false,
    state: "active",
    cpu: 2,
    mem: 4,
    disk: 10,
    gpu: 0,
    sandboxClass: "container",
};

function sandbox() {
    const created = Date.now() - 1000;
    return {
        id: sandboxId,
        name: daytonaSandboxName(configuration, runId),
        organizationId: configuration.organizationId,
        labels: {
            "homelab.owner": daytonaBindingHash(configuration),
            "homelab.run": runId,
            "homelab.service": "mira",
        },
        state: "started",
        env: {},
        public: false,
        networkBlockAll: false,
        networkAllowList: "",
        domainAllowList: "",
        kvm: false,
        cpu: 2,
        memory: 4,
        disk: 10,
        gpu: 0,
        target: "eu",
        snapshot: configuration.snapshotId,
        autoDeleteInterval: 0,
        autoStopInterval: 5,
        autoPauseInterval: 0,
        createdAt: new Date(created).toISOString(),
        autoDestroyAt: new Date(created + 15 * 60_000).toISOString(),
    };
}
function transport(
    handler: (path: string, init: RequestInit) => Response | Promise<Response>
) {
    const calls: { path: string; init: RequestInit }[] = [];
    const request = Object.assign(
        async (
            input: Parameters<typeof fetch>[0],
            options?: Parameters<typeof fetch>[1]
        ) => {
            if (typeof input !== "string" || !options)
                throw new Error("Expected explicit request.");
            const url = new URL(input);
            expect(url.origin).toBe("https://app.daytona.io");
            expect(url.search).toBe("");
            expect(options).toMatchObject({ credentials: "omit", redirect: "error" });
            expect(options.signal).toBeInstanceOf(AbortSignal);
            expect(new Headers(options.headers).get("authorization")).toBe(
                `Bearer ${configuration.apiKey}`
            );
            expect(new Headers(options.headers).get("x-daytona-organization-id")).toBe(
                configuration.organizationId
            );
            calls.push({ path: url.pathname, init: options });
            return handler(url.pathname, options);
        },
        { preconnect: fetch.preconnect }
    );
    return { client: new DaytonaClient(configuration, request), calls };
}
function fixture(path: string, init: RequestInit): Response {
    if (path === "/api/api-keys/current") return Response.json(key);
    if (path === `/api/organizations/${configuration.organizationId}`)
        return Response.json({ id: configuration.organizationId, suspended: false });
    if (path === `/api/organizations/${configuration.organizationId}/users`)
        return Response.json([
            {
                organizationId: configuration.organizationId,
                userId: key.userId,
                role: "owner",
            },
        ]);
    if (path === `/api/snapshots/${configuration.snapshotId}`)
        return Response.json(snapshot);
    return Response.json({
        ...sandbox(),
        state: init.method === "DELETE" ? "destroying" : "started",
    });
}

test("Daytona configuration is explicit and credential rotation preserves the binding", () => {
    expect(
        daytonaConfiguration({
            DAYTONA_API_KEY: configuration.apiKey,
            DAYTONA_API_URL: "https://untrusted.example/",
        })
    ).toBeUndefined();
    const environment = {
        HOMELAB_MIRA_DAYTONA_TRUST_BOUNDARY: configuration.trustBoundary,
        HOMELAB_MIRA_DAYTONA_NETWORK_ACCESS: configuration.networkAccess,
        HOMELAB_MIRA_DAYTONA_OWNER: configuration.owner,
        HOMELAB_MIRA_DAYTONA_ORGANIZATION_ID: configuration.organizationId,
        HOMELAB_MIRA_DAYTONA_SNAPSHOT_ID: configuration.snapshotId,
        HOMELAB_MIRA_DAYTONA_TARGET: configuration.target,
    };
    expect(daytonaBinding(environment)).toEqual({
        trustBoundary: configuration.trustBoundary,
        networkAccess: configuration.networkAccess,
        owner: configuration.owner,
        organizationId: configuration.organizationId,
        snapshotId: configuration.snapshotId,
        target: "eu",
    });
    expect(daytonaConfiguration(environment)).toBeUndefined();
    expect(
        daytonaConfiguration({
            ...environment,
            HOMELAB_MIRA_DAYTONA_API_KEY: configuration.apiKey,
        })
    ).toEqual(configuration);
    const rotated = { ...configuration, apiKey: "synthetic-rotated-key" };
    expect(daytonaBindingHash(rotated)).toBe(daytonaBindingHash(configuration));
    for (const change of [
        { owner: "other" },
        { organizationId: otherId },
        { snapshotId: otherId },
        { target: "us" },
    ])
        expect(daytonaBindingHash({ ...configuration, ...change })).not.toBe(
            daytonaBindingHash(configuration)
        );
    for (const change of [
        { HOMELAB_MIRA_DAYTONA_TRUST_BOUNDARY: undefined },
        { HOMELAB_MIRA_DAYTONA_TRUST_BOUNDARY: "shared-organization" },
        { HOMELAB_MIRA_DAYTONA_NETWORK_ACCESS: undefined },
        { HOMELAB_MIRA_DAYTONA_NETWORK_ACCESS: "block-all" },
        { HOMELAB_MIRA_DAYTONA_ORGANIZATION_ID: "name" },
        { HOMELAB_MIRA_DAYTONA_SNAPSHOT_ID: "latest" },
        { HOMELAB_MIRA_DAYTONA_TARGET: "../api" },
        { HOMELAB_MIRA_DAYTONA_OWNER: "operator\n" },
    ])
        expect(() => daytonaBinding({ ...environment, ...change })).toThrow();
    expect(() => daytonaBinding({ HOMELAB_MIRA_DAYTONA_OWNER: "operator" })).toThrow();
    expect(() =>
        daytonaConfiguration({ HOMELAB_MIRA_DAYTONA_API_KEY: configuration.apiKey })
    ).toThrow();
    expect(() =>
        daytonaConfiguration({ ...environment, HOMELAB_MIRA_DAYTONA_API_KEY: "bad\nkey" })
    ).toThrow();
    expect(() => new DaytonaClient({ ...configuration, apiKey: "short" })).toThrow();
    expect(() => daytonaSandboxName(configuration, "../keys")).toThrow();
    expect(daytonaSandboxName(configuration, runId)).not.toContain(configuration.owner);
    expect(daytonaSandboxName(configuration, runId).length).toBeLessThan(64);
    expect(Object.isFrozen(daytonaPolicy)).toBe(true);
});

test("Daytona create checks account and snapshot before admission and posts fixed bounded isolation settings once", async () => {
    const { client, calls } = transport(fixture);
    const result = await client.create(runId, signal, () => {
        expect(calls.map((call) => call.init.method)).toEqual([
            "GET",
            "GET",
            "GET",
            "GET",
        ]);
        return Promise.resolve();
    });
    expect(calls.map((call) => call.init.method)).toEqual([
        "GET",
        "GET",
        "GET",
        "GET",
        "POST",
    ]);
    const body = calls[4]?.init.body;
    if (typeof body !== "string") throw new Error("Expected JSON body");
    expect(JSON.parse(body)).toEqual({
        name: daytonaSandboxName(configuration, runId),
        snapshot: configuration.snapshotId,
        target: "eu",
        labels: {
            "homelab.owner": daytonaBindingHash(configuration),
            "homelab.run": runId,
            "homelab.service": "mira",
        },
        env: {},
        public: false,
        networkBlockAll: false,
        kvm: false,
        volumes: [],
        secrets: [],
        cpu: 2,
        memory: 4,
        disk: 10,
        gpu: 0,
        autoStopInterval: 5,
        autoPauseInterval: 0,
        autoDeleteInterval: 0,
        ttlMinutes: 15,
        queueTimeout: 2,
    });
    expect(result).toMatchObject({
        id: sandboxId,
        state: "started",
        settingsMatch: true,
    });
    expect(JSON.stringify(calls[4]?.init.body)).not.toContain(configuration.apiKey);
});

for (const change of [
    { organizationId: otherId },
    { organizationId: undefined },
    { permissions: ["write:sandboxes"] },
    { permissions: ["delete:sandboxes"] },
    { expiresAt: "2020-01-01T00:00:00Z" },
    { expiresAt: "invalid" },
])
    test(`Daytona denies unqualified key ${JSON.stringify(change)} before creation`, async () => {
        const { client, calls } = transport(() => Response.json({ ...key, ...change }));
        let admitted = false;
        await rejects(
            client.create(runId, signal, () => {
                admitted = true;
                return Promise.resolve();
            })
        );
        expect(admitted).toBe(false);
        expect(calls).toHaveLength(1);
    });

for (const change of [
    { id: otherId },
    { organizationId: otherId },
    { general: true },
    { state: "inactive" },
    { gpu: 1 },
    { disk: 50 },
    { mem: 16 },
    { cpu: 8 },
    { sandboxClass: "linux-vm" },
])
    test(`Daytona denies unqualified snapshot ${JSON.stringify(change)}`, async () => {
        const { client, calls } = transport((path, init) =>
            path.includes("snapshots")
                ? Response.json({ ...snapshot, ...change })
                : fixture(path, init)
        );
        await rejects(client.create(runId, signal, async () => {}));
        expect(calls.map((call) => call.init.method)).toEqual([
            "GET",
            "GET",
            "GET",
            "GET",
        ]);
    });

test("Daytona admission revocation or cancellation after preflight sends no create", async () => {
    const denied = transport(fixture);
    await rejects(
        denied.client.create(runId, signal, () =>
            Promise.reject(new Error("permission changed"))
        ),
        /permission changed/
    );
    expect(denied.calls).toHaveLength(4);
    const cancelled = transport(fixture),
        controller = new AbortController();
    await rejects(
        cancelled.client.create(runId, controller.signal, () => {
            controller.abort();
            return Promise.resolve();
        })
    );
    expect(cancelled.calls).toHaveLength(4);
    const before = transport(fixture);
    await rejects(before.client.inspect({ runId }, controller.signal));
    expect(before.calls).toHaveLength(0);
});

for (const failure of ["network", "429", "500", "json", "identity", "aborted"] as const)
    test(`Daytona create ${failure} outcome is uncertain and is never replayed`, async () => {
        const controller = new AbortController();
        const { client, calls } = transport((path, init) => {
            if (init.method !== "POST") return fixture(path, init);
            if (failure === "network")
                throw new Error("credential-bearing private error");
            if (failure === "aborted") {
                controller.abort();
                throw new Error("aborted");
            }
            if (failure === "429" || failure === "500")
                return new Response("private provider diagnostics", {
                    status: Number(failure),
                });
            if (failure === "json") return new Response("not json");
            return Response.json({ ...sandbox(), organizationId: otherId });
        });
        await rejects(
            client.create(runId, controller.signal, async () => {}),
            (error) => {
                expect(error).toBeInstanceOf(DaytonaUncertainMutation);
                expect((error as DaytonaUncertainMutation).reference).toEqual({ runId });
                expect(String(error)).not.toContain("private");
                return true;
            }
        );
        expect(calls.filter((call) => call.init.method === "POST")).toHaveLength(1);
    });

test("Daytona reconciles a lost acknowledgement by deterministic name without starting another sandbox", async () => {
    const { client, calls } = transport((path) =>
        Response.json(
            path.includes("api-keys")
                ? key
                : {
                      ...sandbox(),
                      env: {},
                      toolboxProxyUrl: "https://untrusted.example/",
                      errorReason: "private",
                  }
        )
    );
    const found = await client.inspect({ runId }, signal);
    expect(found).toMatchObject({ id: sandboxId, settingsMatch: true });
    expect(calls[1]?.path).toBe(
        `/api/sandbox/${daytonaSandboxName(configuration, runId)}`
    );
    expect(calls.every((call) => call.init.method === "GET")).toBe(true);
    expect(JSON.stringify(found)).not.toContain("private");
    expect(JSON.stringify(found)).not.toContain("toolboxProxyUrl");
    await rejects(client.inspect({ runId, sandboxId: "../api-keys" }, signal));
    expect(calls).toHaveLength(2);
});

for (const change of [
    { id: otherId },
    { organizationId: otherId },
    { name: "foreign-sandbox" },
    { labels: {} },
    {
        labels: {
            "homelab.owner": daytonaBindingHash(configuration),
            "homelab.run": otherId,
            "homelab.service": "mira",
        },
    },
])
    test(`Daytona refuses deletion when ownership differs: ${JSON.stringify(change)}`, async () => {
        const { client, calls } = transport((path) =>
            Response.json(path.includes("api-keys") ? key : { ...sandbox(), ...change })
        );
        await rejects(client.destroy({ runId, sandboxId }, signal));
        expect(calls).toHaveLength(2);
        expect(calls.every((call) => call.init.method === "GET")).toBe(true);
    });

for (const change of [
    { env: { SECRET: "private" } },
    { env: undefined },
    { public: true },
    { networkBlockAll: true },
    { networkAllowList: "0.0.0.0/0" },
    { domainAllowList: "*" },
    { outboundProxyUrl: "https://untrusted.example/" },
    { kvm: true },
    { linkedSandboxId: otherId },
    { volumes: [{ id: otherId }] },
    { cpu: 8 },
    { memory: 32 },
    { disk: 100 },
    { gpu: 1 },
    { target: "us" },
    { snapshot: otherId },
    { autoDeleteInterval: -1 },
    { autoStopInterval: 0 },
    { autoPauseInterval: 60 },
    { autoDestroyAt: undefined },
    { autoDestroyAt: "2020-01-01T00:00:00Z" },
    { createdAt: "2020-01-01T00:00:00Z" },
    { autoDestroyAt: "2099-01-01T00:00:00Z" },
])
    test(`Daytona reports settings drift without preventing owned cleanup: ${JSON.stringify(change)}`, async () => {
        const { client, calls } = transport((path, init) => {
            if (path.includes("api-keys")) return Response.json(key);
            if (path.includes("snapshots"))
                return new Response("unavailable", { status: 503 });
            return Response.json({
                ...sandbox(),
                ...change,
                state: init.method === "DELETE" ? "destroying" : "started",
            });
        });
        const observed = await client.inspect({ runId, sandboxId }, signal);
        expect(observed?.settingsMatch).toBe(false);
        expect(JSON.stringify(observed)).not.toContain("private");
        expect(await client.destroy({ runId, sandboxId }, signal)).toBe("requested");
        expect(calls.filter((call) => call.init.method === "DELETE")).toHaveLength(1);
        expect(calls.at(-1)?.path).toBe(`/api/sandbox/${sandboxId}`);
    });

test("Daytona accepts a name-only snapshot receipt only after resolving the configured immutable snapshot", async () => {
    const { client } = transport((path, init) =>
        path.includes("sandbox/")
            ? Response.json({ ...sandbox(), snapshot: snapshot.name })
            : fixture(path, init)
    );
    const observed = await client.inspect({ runId }, signal);
    expect(observed?.settingsMatch).toBe(true);
});

test("Daytona separates absent, confirmed destroyed and merely requested deletion", async () => {
    for (const outcome of ["absent", "destroyed", "requested"] as const) {
        const { client, calls } = transport((path) => {
            if (path.includes("api-keys")) return Response.json(key);
            if (outcome === "absent") return new Response("not found", { status: 404 });
            return Response.json({
                ...sandbox(),
                state: outcome === "destroyed" ? "destroyed" : "destroying",
            });
        });
        expect(await client.destroy({ runId, sandboxId }, signal)).toBe(outcome);
        expect(calls.filter((call) => call.init.method === "DELETE").length).toBe(
            outcome === "requested" ? 1 : 0
        );
    }
    const known = transport((path, init) =>
        init.method === "DELETE"
            ? Response.json({ ...sandbox(), state: "destroyed" })
            : fixture(path, init)
    );
    expect(await known.client.destroy({ runId, sandboxId }, signal)).toBe("destroyed");
});

test("Daytona deletion timeouts keep the exact known provider ID for recovery without retrying", async () => {
    const { client, calls } = transport((path, init) => {
        if (init.method === "DELETE") throw new Error("private token details");
        return fixture(path, init);
    });
    await rejects(client.destroy({ runId }, signal), (error) => {
        expect(error).toBeInstanceOf(DaytonaUncertainMutation);
        expect((error as DaytonaUncertainMutation).reference).toEqual({
            runId,
            sandboxId,
        });
        expect(String(error)).not.toContain("private");
        return true;
    });
    expect(calls.filter((call) => call.init.method === "DELETE")).toHaveLength(1);
});

test("Daytona bounds advertised and streamed metadata and cancels oversized bodies", async () => {
    let cancelled = 0;
    for (const advertised of [true, false]) {
        const { client } = transport(
            () =>
                new Response(
                    new ReadableStream<Uint8Array>({
                        pull(controller) {
                            controller.enqueue(new Uint8Array(256 * 1024 + 1));
                        },
                        cancel() {
                            cancelled++;
                        },
                    }),
                    { headers: advertised ? { "content-length": "262145" } : {} }
                )
        );
        await rejects(client.preflight(signal), /invalid response/);
    }
    expect(cancelled).toBe(2);
});

for (const members of [
    [],
    [
        {
            organizationId: configuration.organizationId,
            userId: "different-owner",
            role: "owner",
        },
    ],
    [{ organizationId: otherId, userId: key.userId, role: "owner" }],
    [
        {
            organizationId: configuration.organizationId,
            userId: key.userId,
            role: "member",
        },
    ],
    [
        {
            organizationId: configuration.organizationId,
            userId: key.userId,
            role: "owner",
        },
        {
            organizationId: configuration.organizationId,
            userId: "additional-member",
            role: "owner",
        },
    ],
])
    test("Daytona blocks creation when dedicated organization membership is not confirmed", async () => {
        const { client, calls } = transport((path, init) =>
            path.endsWith("/users") ? Response.json(members) : fixture(path, init)
        );
        let admitted = false;
        await rejects(
            client.create(runId, signal, () => {
                admitted = true;
                return Promise.resolve();
            })
        );
        expect(admitted).toBe(false);
        expect(calls.every((call) => call.init.method === "GET")).toBe(true);
        expect(calls.some((call) => call.path.includes("snapshots"))).toBe(false);
        expect(await client.destroy({ runId, sandboxId }, signal)).toBe("requested");
    });
for (const change of [{ id: otherId }, { suspended: true }])
    test("Daytona blocks an unavailable or different organization before claiming resources", async () => {
        const { client, calls } = transport((path, init) =>
            path === `/api/organizations/${configuration.organizationId}`
                ? Response.json({
                      id: configuration.organizationId,
                      suspended: false,
                      ...change,
                  })
                : fixture(path, init)
        );
        await rejects(client.create(runId, signal, async () => {}));
        expect(calls.every((call) => call.init.method === "GET")).toBe(true);
    });
