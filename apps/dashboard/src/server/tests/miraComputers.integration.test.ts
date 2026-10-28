import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";

import { capabilities } from "@homelab/contracts/operations";
import {
    connectMiraComputer,
    enrollMiraComputer,
    heartbeatMiraComputer,
} from "@homelab/mira/data/computers";

import { appRouter } from "../api/router";
import { authenticateAutomation } from "../automation/authentication";
import { startDashboardServer } from "../index";
import { miraComputerReceiver } from "../mira/computerReceiver";
import { operationFixture } from "../testing/operations";

const metadata = () => ({
    installationId: crypto.randomUUID(),
    platform: "win32",
    version: "0.10.0",
});
async function fixture() {
    const f = await operationFixture();
    let verifications = 0;
    const caller = (
        id = "operator",
        verifiedId = id,
        kind: "human" | "automation" = "human"
    ) =>
        appRouter.createCaller({
            operations: f,
            principal: { kind, id, capabilities },
            verifyHuman: () => {
                verifications++;
                return Promise.resolve({ kind, id: verifiedId, capabilities });
            },
        }).mira.computers;
    const api = caller();
    const enroll = async () => {
        const pair = await api.pair({ label: "Synthetic PC" });
        const device = await enrollMiraComputer(f.client, pair.token, metadata());
        return { pair, device };
    };
    return { ...f, caller, api, enroll, verifications: () => verifications };
}

test("computer pairing requires a freshly verified human and isolates metadata and revocation by owner", async () => {
    const f = await fixture();
    try {
        await rejects(
            f.caller("operator", "other").pair({ label: "Wrong identity" }),
            /account changed/
        );
        await rejects(
            f.caller("machine", "machine", "automation").pair({ label: "Machine" }),
            /signed-in operator/
        );
        const missing = appRouter.createCaller({
            operations: f,
            principal: { kind: "human", id: "operator", capabilities },
        }).mira.computers;
        await rejects(missing.pair({ label: "No MFA verifier" }), /verified operator/);
        const { pair, device } = await f.enroll();
        const listed = await f.api.list();
        expect(listed).toHaveLength(1);
        expect(listed[0]).toMatchObject({
            id: pair.id,
            state: "paired",
            version: 2,
            platform: "win32",
            connected: false,
        });
        expect(JSON.stringify(listed)).not.toContain("digest");
        expect(JSON.stringify(listed)).not.toContain(device.credential);
        expect(await f.caller("other").list()).toEqual([]);
        await rejects(f.caller("other").revoke({ id: pair.id, version: 2 }), /changed/);
        await rejects(missing.revoke({ id: pair.id, version: 2 }), /verified operator/);
        expect(f.verifications()).toBeGreaterThan(1);
        await f.api.revoke({ id: pair.id, version: 2 });
        expect(await f.api.list()).toMatchObject([
            { state: "revoked", version: 3, connected: false },
        ]);
        const audit = await f.client<
            { action: string; target: string; actor: string }[]
        >`SELECT action,target,actor FROM mira_audit ORDER BY id`;
        expect(audit.map((r) => r.action)).toEqual([
            "computer.pairing_created",
            "computer.enrolled",
            "computer.revoked",
        ]);
        expect(JSON.stringify(audit)).not.toContain(pair.token);
        expect(JSON.stringify(audit)).not.toContain(device.credential);
    } finally {
        await f.close();
    }
});

test("concurrent enrollment consumes one ticket exactly once and never returns replacement credentials", async () => {
    const f = await fixture();
    try {
        const pair = await f.api.pair({ label: "One PC" });
        const results = await Promise.allSettled([
            enrollMiraComputer(f.client, pair.token, metadata()),
            enrollMiraComputer(f.client, pair.token, metadata()),
        ]);
        expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
        expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
        const enrolled = results.find((r) => r.status === "fulfilled")!;
        if (enrolled.status !== "fulfilled") throw new Error("Expected one enrollment.");
        expect(enrolled.value.controlAllowed).toBe(false);
        await rejects(
            enrollMiraComputer(f.client, pair.token, metadata()),
            /invalid or expired/
        );
        await rejects(connectMiraComputer(f.client, pair.token), /invalid or expired/);
        await rejects(
            enrollMiraComputer(f.client, enrolled.value.credential, metadata()),
            /invalid or expired/
        );
        const [stored] = await f.client<
            { pair_digest: string | null; credential_digest: string }[]
        >`SELECT pair_digest,credential_digest FROM mira_computers WHERE id=${pair.id}`;
        expect(stored!.pair_digest).toBeNull();
        expect(stored!.credential_digest).toMatch(/^[a-f0-9]{64}$/);
        expect(stored!.credential_digest).not.toBe(enrolled.value.credential);
        await rejects(
            authenticateAutomation(f.client, `Bearer ${enrolled.value.credential}`)
        );
    } finally {
        await f.close();
    }
});

test("expired, revoked and forged tickets never enroll or extend their lifetime", async () => {
    const f = await fixture();
    try {
        for (const mode of ["expired", "revoked", "forged"]) {
            const pair = await f.api.pair({ label: mode });
            if (mode === "expired")
                await f.client`UPDATE mira_computers SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${pair.id}`;
            if (mode === "revoked") await f.api.revoke({ id: pair.id, version: 1 });
            const token =
                mode === "forged"
                    ? pair.token.slice(0, -1) + (pair.token.endsWith("A") ? "B" : "A")
                    : pair.token;
            await rejects(
                enrollMiraComputer(f.client, token, metadata()),
                /invalid or expired/
            );
            const [row] = await f.client<
                { credential_digest: string | null }[]
            >`SELECT credential_digest FROM mira_computers WHERE id=${pair.id}`;
            expect(row!.credential_digest).toBeNull();
        }
    } finally {
        await f.close();
    }
});

test("new connection generations reject old, duplicated and expired heartbeats", async () => {
    const f = await fixture();
    try {
        const { pair, device } = await f.enroll();
        const first = await connectMiraComputer(f.client, device.credential);
        expect(first).toMatchObject({
            controlAllowed: false,
            heartbeatSeconds: 15,
            leaseSeconds: 45,
        });
        expect(
            await heartbeatMiraComputer(f.client, device.credential, {
                connectionId: first.connectionId,
                sequence: 1,
            })
        ).toMatchObject({ controlAllowed: false });
        await rejects(
            heartbeatMiraComputer(f.client, device.credential, {
                connectionId: first.connectionId,
                sequence: 1,
            }),
            /connection/
        );
        const next = await connectMiraComputer(f.client, device.credential);
        expect(next.connectionId).not.toBe(first.connectionId);
        await rejects(
            heartbeatMiraComputer(f.client, device.credential, {
                connectionId: first.connectionId,
                sequence: 2,
            }),
            /connection/
        );
        await heartbeatMiraComputer(f.client, device.credential, {
            connectionId: next.connectionId,
            sequence: 1,
        });
        expect(await f.api.list()).toMatchObject([{ connected: true }]);
        await f.client`UPDATE mira_computers SET connection_expires_at=clock_timestamp()-interval '1 second' WHERE id=${pair.id}`;
        expect(await f.api.list()).toMatchObject([{ connected: false }]);
        await rejects(
            heartbeatMiraComputer(f.client, device.credential, {
                connectionId: next.connectionId,
                sequence: 2,
            }),
            /connection/
        );
        const recovered = await connectMiraComputer(f.client, device.credential);
        await heartbeatMiraComputer(f.client, device.credential, {
            connectionId: recovered.connectionId,
            sequence: 1,
        });
        await f.api.revoke({ id: pair.id, version: 2 });
        await rejects(
            connectMiraComputer(f.client, device.credential),
            /invalid or expired/
        );
        await rejects(
            heartbeatMiraComputer(f.client, device.credential, {
                connectionId: recovered.connectionId,
                sequence: 2,
            }),
            /connection/
        );
        const [row] = await f.client<
            {
                credential_digest: string | null;
                connection_id: string | null;
                connection_expires_at: Date | null;
            }[]
        >`SELECT credential_digest,connection_id,connection_expires_at FROM mira_computers WHERE id=${pair.id}`;
        expect(row).toEqual({
            credential_digest: null,
            connection_id: null,
            connection_expires_at: null,
        });
    } finally {
        await f.close();
    }
});

test("credential expiry and concurrent revoke versus reconnect cannot restore device access", async () => {
    const f = await fixture();
    try {
        const { pair, device } = await f.enroll();
        await Promise.allSettled([
            f.api.revoke({ id: pair.id, version: 2 }),
            connectMiraComputer(f.client, device.credential),
        ]);
        expect(await f.api.list()).toMatchObject([
            { state: "revoked", connected: false },
        ]);
        await rejects(connectMiraComputer(f.client, device.credential));
        const other = await f.enroll();
        await f.client`UPDATE mira_computers SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${other.pair.id}`;
        await rejects(connectMiraComputer(f.client, other.device.credential));
        await rejects(
            heartbeatMiraComputer(f.client, other.device.credential, {
                connectionId: crypto.randomUUID(),
                sequence: 1,
            })
        );
    } finally {
        await f.close();
    }
});

test("pairing quotas serialize simultaneous tickets and bound even revoked-ticket churn", async () => {
    const f = await fixture();
    try {
        const issued = await Promise.allSettled(
            Array.from({ length: 21 }, (_, i) => f.api.pair({ label: `PC ${i}` }))
        );
        expect(issued.filter((r) => r.status === "fulfilled")).toHaveLength(20);
        expect(issued.filter((r) => r.status === "rejected")).toHaveLength(1);
        for (const row of await f.api.list())
            await f.api.revoke({ id: row.id, version: row.version });
        await rejects(f.api.pair({ label: "Too soon" }), /limit/);
        expect(await f.caller("other").pair({ label: "Separate owner" })).toHaveProperty(
            "id"
        );
        await f.client`UPDATE mira_computers SET created_at=clock_timestamp()-interval '2 hours' WHERE owner='operator'`;
        expect(await f.api.pair({ label: "After cooldown" })).toHaveProperty("id");
    } finally {
        await f.close();
    }
});

test("real HTTP enrollment and heartbeats reject browser credentials, query secrets and control commands", async () => {
    const f = await fixture();
    const receiver = miraComputerReceiver(f.client);
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: receiver });
    const base = `http://127.0.0.1:${server.port}/api/mira/computers`;
    const pair = await f.api.pair({ label: "HTTP PC" });
    const post = (
        route: string,
        token: string,
        data: unknown,
        extra: Record<string, string> = {}
    ) =>
        fetch(base + route, {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${token}`,
                ...extra,
            },
            body: JSON.stringify(data),
        });

    try {
        for (const extra of [
            { origin: "https://example.invalid" },
            { cookie: "session=synthetic" },
        ])
            await status(post("/enroll", pair.token, metadata(), extra), 403);
        await status(post("/enroll?token=synthetic", pair.token, metadata()), 404);
        await status(post("/enroll", pair.token, { ...metadata(), owner: "other" }), 400);
        await status(post("/enroll", pair.token, { padding: "x".repeat(2049) }), 400);
        const enrolled = await post("/enroll", pair.token, metadata());
        expect(enrolled.status).toBe(200);
        expect(enrolled.headers.get("cache-control")).toBe("no-store");
        const device = (await enrolled.json()) as {
            credential: string;
            controlAllowed: boolean;
        };
        expect(device.controlAllowed).toBe(false);
        const connected = await post("/connect", device.credential, {});
        const connection = (await connected.json()) as { connectionId: string };
        expect(connected.status).toBe(200);
        await status(
            post("/heartbeat", device.credential, {
                connectionId: connection.connectionId,
                sequence: 1,
            }),
            200
        );
        await status(post("/click", device.credential, { x: 0, y: 0 }), 404);
        await status(post("/connect", device.credential, { command: "observe" }), 400);
        await status(post("/enroll", pair.token, metadata()), 403);
        await status(fetch(base + "/enroll"), 405);
        await status(post("/enroll", "invalid", metadata()), 403);
        await status(
            post("/enroll", pair.token, metadata(), { "content-type": "text/plain" }),
            415
        );
    } finally {
        await server.stop(true);
        await f.close();
    }
});

test("the server never activates the computer endpoint without identity and operations configuration", async () => {
    const server = startDashboardServer({
        hostname: "127.0.0.1",
        port: 0,
        authentication: null,
        operations: null,
        development: false,
    });
    try {
        const result = await fetch(
            `http://127.0.0.1:${server.port}/api/mira/computers/enroll`,
            { method: "POST" }
        );
        expect(result.status).toBe(404);
        expect(result.headers.get("cache-control")).toBe("no-store");
    } finally {
        await server.stop(true);
    }
});

async function status(pending: Promise<Response>, expected: number) {
    const result = await pending;
    expect(result.status).toBe(expected);
    await result.arrayBuffer();
}

test("machine request bodies have a deadline and a bounded concurrency budget", async () => {
    const f = await fixture();
    const pair = await f.api.pair({ label: "Body bounds" });
    const receiver = miraComputerReceiver(f.client);
    const controllers: ReadableStreamDefaultController<Uint8Array>[] = [];
    const request = () =>
        new Request("https://synthetic.invalid/api/mira/computers/enroll", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${pair.token}`,
            },
            body: new ReadableStream<Uint8Array>({
                start(controller) {
                    controllers.push(controller);
                },
            }),
        });
    try {
        const pending = Array.from({ length: 8 }, () => receiver(request()));
        const overflow = await receiver(request());
        expect(overflow.status).toBe(429);
        for (const controller of controllers) controller.close();
        const results = await Promise.all(pending);
        expect(results.every((result) => result.status === 400)).toBe(true);
        const started = performance.now();
        const expired = await receiver(request());
        expect(expired.status).toBe(400);
        expect(performance.now() - started).toBeLessThan(6000);
        const parsed = await receiver(
            new Request("https://synthetic.invalid/api/mira/computers/enroll", {
                method: "POST",
                headers: {
                    "content-type": "application/json",
                    authorization: `Bearer ${pair.token}`,
                },
                body: JSON.stringify(metadata()),
            })
        );
        expect(parsed.status).toBe(200);
    } finally {
        await f.close();
    }
}, 10_000);

test("machine presence is isolated from the public dashboard and both listeners stop together", async () => {
    const f = await fixture();
    const server = startDashboardServer({
        hostname: "127.0.0.1",
        port: 0,
        development: false,
        computerBinding: { hostname: "127.0.0.1", port: 0 },
        authentication: {
            issuer: "https://identity.example.invalid",
            origin: "https://dashboard.example.invalid",
            clientId: "synthetic",
            clientSecret: "synthetic",
            tokenEndpointAuthMethod: "client_secret_post",
            sessionKey: new Uint8Array(32),
            development: false,
        },
        operations: {
            databaseUrl: f.url,
            metricsUrl: undefined,
            metricsToken: undefined,
            concurrency: 3,
            retentionDays: 30,
        },
    });
    const privateOrigin = `http://127.0.0.1:${server.computerPort}`;
    const publicOrigin = `http://127.0.0.1:${server.port}`;
    const pair = await f.api.pair({ label: "Private PC" });
    const init = {
        method: "POST",
        headers: {
            "content-type": "application/json",
            authorization: `Bearer ${pair.token}`,
        },
        body: JSON.stringify(metadata()),
    };
    try {
        await status(fetch(publicOrigin + "/api/mira/computers/enroll", init), 404);
        await status(
            fetch(publicOrigin + "/api/mira/computers/update", { ...init, body: "{}" }),
            404
        );
        await status(fetch(privateOrigin + "/api/trpc/system.status"), 404);
        await status(fetch(privateOrigin + "/"), 404);
        await status(fetch(privateOrigin + "/api/mira/computers/enroll", init), 200);
        expect(await f.api.list()).toMatchObject([{ state: "paired" }]);
    } finally {
        await server.stop(true);
        await f.close();
    }
    await rejects(fetch(privateOrigin));
    await rejects(fetch(publicOrigin));
});

test("reconnection refreshes the authenticated client version without changing pairing or granting input", async () => {
    const f = await fixture();
    try {
        const { device, pair } = await f.enroll();
        expect(
            await connectMiraComputer(f.client, device.credential, { version: "0.11.0" })
        ).toMatchObject({ controlAllowed: false });
        expect(await f.api.list()).toMatchObject([
            { id: pair.id, version: 2, companionVersion: "0.11.0", connected: true },
        ]);
        await rejects(
            connectMiraComputer(f.client, device.credential, { version: "invalid" })
        );
        const observed1 = await f.api.list();
        expect(observed1[0]?.companionVersion).toBe("0.11.0");
        await connectMiraComputer(f.client, device.credential);
        const observed2 = await f.api.list();
        expect(observed2[0]?.companionVersion).toBeNull();
        await f.api.revoke({ id: pair.id, version: 2 });
        await rejects(
            connectMiraComputer(f.client, device.credential, { version: "0.12.0" }),
            /invalid or expired/
        );
        const observed3 = await f.api.list();
        expect(observed3[0]?.companionVersion).toBeNull();
    } finally {
        await f.close();
    }
});

test("Windows downloads require human access and fresh evidence for the configured repository", async () => {
    const f = await fixture();
    const caller = (
        repository: string | undefined,
        kind: "human" | "automation" = "human"
    ) =>
        appRouter.createCaller({
            operations: {
                ...f,
                ...(repository ? { releaseRepository: repository } : {}),
            },
            principal: { kind, id: "operator", capabilities },
        }).mira.computers;
    const computer = {
        version: "0.10.0",
        revision: "a".repeat(40),
        size: 123,
        sha256: "e".repeat(64),
        url: "https://github.com/demo/homelab/releases/download/v0.10.0/mira-computer-0.10.0-windows-x64-setup.exe",
    };
    const value = { repository: "demo/homelab", verified: true, computer };
    const save = async (data: unknown, seconds = 0) => {
        await f.client`INSERT INTO operation_snapshots(key,value,captured_at) VALUES ('homelab.release',${JSON.stringify(data)}::text::jsonb,now()+${seconds}::int*interval '1 second') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,captured_at=EXCLUDED.captured_at`;
    };
    try {
        await rejects(
            caller("demo/homelab", "automation").download(),
            /signed-in operator/
        );
        const observed4 = await caller("demo/homelab").download();
        expect(observed4.download).toBeNull();
        await save(value);
        const observed5 = await caller("demo/homelab").download();
        expect(observed5.download).toEqual(computer);
        const observed6 = await caller(undefined).download();
        expect(observed6.download).toBeNull();
        const observed7 = await caller("different/repo").download();
        expect(observed7.download).toBeNull();
        await save(value, -1201);
        const observed8 = await caller("demo/homelab").download();
        expect(observed8.download).toBeNull();
        await save({ ...value, verified: false });
        const observed9 = await caller("demo/homelab").download();
        expect(observed9.download).toBeNull();
        await save({ repository: "demo/homelab", verified: true });
        const observed10 = await caller("demo/homelab").download();
        expect(observed10.download).toBeNull();
        await save(value);
        await f.client`INSERT INTO job_runs(id,action,label,resource_class,state,payload,fingerprint,idempotency_key,requested_by,attempt_limit,retry_safe,timeout_ms,resource_keys) VALUES (${Bun.randomUUIDv7()},'homelab.release','Release check','light','failed','{}','synthetic',${Bun.randomUUIDv7()},'synthetic',1,false,1000,ARRAY[]::text[])`;
        const observed11 = await caller("demo/homelab").download();
        expect(observed11.download).toBeNull();
    } finally {
        await f.close();
    }
});

test("private update lookup requires a live paired credential and fresh repository-bound evidence without control authority", async () => {
    const f = await fixture();
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: miraComputerReceiver(f.client, "demo/homelab"),
    });
    const { pair, device } = await f.enroll();
    const post = (token: string, input: unknown = {}, extra?: Record<string, string>) =>
        fetch(new URL("api/mira/computers/update", server.url), {
            method: "POST",
            headers: {
                "content-type": "application/json",
                authorization: `Bearer ${token}`,
                ...extra,
            },
            body: JSON.stringify(input),
        });
    const candidate = {
        version: "0.11.0",
        revision: "a".repeat(40),
        size: 100,
        sha256: "b".repeat(64),
        url: "https://ignored.invalid/untrusted.exe",
    };
    const save = async (value: unknown, age = 0) => {
        await f.client`INSERT INTO operation_snapshots(key,value,captured_at) VALUES ('homelab.release',${JSON.stringify(value)}::text::jsonb,now()-${age}::int*interval '1 second') ON CONFLICT(key) DO UPDATE SET value=EXCLUDED.value,captured_at=EXCLUDED.captured_at`;
    };
    try {
        await save({ repository: "demo/homelab", verified: true, computer: candidate });
        await status(post(pair.token), 403);
        await status(
            post(device.credential, {}, { origin: "https://example.test" }),
            403
        );
        await status(post(device.credential, {}, { cookie: "session=synthetic" }), 403);
        await status(
            post(device.credential, { url: "https://another.invalid/installer" }),
            400
        );
        const response = await post(device.credential);
        expect(response.status).toBe(200);
        expect(response.headers.get("cache-control")).toBe("no-store");
        const result = (await response.json()) as {
            update: { repository: string; version: string; validForMs: number };
        };
        expect(result.update).toMatchObject({
            repository: "demo/homelab",
            version: "0.11.0",
        });
        expect(result.update.validForMs).toBeGreaterThan(0);
        expect(result.update.validForMs).toBeLessThanOrEqual(300_000);
        expect(JSON.stringify(result)).not.toContain("url");
        expect(JSON.stringify(result)).not.toContain(device.credential);
        expect(await f.api.list()).toMatchObject([
            { id: pair.id, version: 2, connected: false },
        ]);
        for (const value of [
            { repository: "other/repo", verified: true, computer: candidate },
            { repository: "demo/homelab", verified: false, computer: candidate },
            {
                repository: "demo/homelab",
                verified: true,
                computer: { ...candidate, sha256: "invalid" },
            },
            { repository: "demo/homelab", verified: true },
        ]) {
            await save(value);
            const unavailable = await post(device.credential);
            expect(await unavailable.json()).toEqual({ update: null });
        }
        await save(
            { repository: "demo/homelab", verified: true, computer: candidate },
            1201
        );
        const stale = await post(device.credential);
        expect(await stale.json()).toEqual({ update: null });
        await f.client`UPDATE mira_computers SET expires_at=clock_timestamp()-interval '1 second' WHERE id=${pair.id}`;
        await status(post(device.credential), 403);
        await f.api.revoke({ id: pair.id, version: 2 });
        await status(post(device.credential), 403);
    } finally {
        await server.stop(true);
        await f.close();
    }
});
