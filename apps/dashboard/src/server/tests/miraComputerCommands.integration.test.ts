import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";

import { capabilities } from "@homelab/contracts/operations";
import {
    acceptMiraComputerAccess,
    permitMiraComputerAccessLocally,
    stopMiraComputerAccessLocally,
} from "@homelab/mira/data/computerAccess";
import {
    claimMiraComputerCommand,
    cleanupMiraComputerCommands,
    enqueueMiraComputerCommand,
    finishMiraComputerCommand,
    takeMiraComputerCommand,
} from "@homelab/mira/data/computerCommands";
import { connectMiraComputer, enrollMiraComputer } from "@homelab/mira/data/computers";
import { cancelRun } from "@homelab/mira/data/conversations";
import { claimMiraRun } from "@homelab/mira/data/queue";

import { createVisualChallenge } from "../../../../mira/src/server/testing/visualChallenge";
import { appRouter } from "../api/router";
import { startDashboardServer } from "../index";
import { miraComputerReceiver } from "../mira/computerReceiver";
import { operationFixture } from "../testing/operations";

async function session(
    f: Awaited<ReturnType<typeof operationFixture>>,
    owner = "operator",
    mode: "view" | "control" = "control"
) {
    const api = appRouter.createCaller({
        operations: f,
        principal: { kind: "human", id: owner, capabilities },
        verifyHuman: () => Promise.resolve({ kind: "human", id: owner, capabilities }),
    }).mira;
    const context = { client: f.client, owner, actor: `human:${owner}` };
    const chat = await api.conversations.create({ title: "Synthetic command transport" });
    await api.conversations.send({
        conversationId: chat.id,
        requestId: crypto.randomUUID(),
        text: "Synthetic run",
        attachmentIds: [],
    });
    const run = await claimMiraRun(f.client, crypto.randomUUID(), "foreground");
    if (!run) throw new Error("Expected synthetic run.");
    // Queue-capacity fixtures need independent live leases without occupying a real executor lane.
    await f.client`UPDATE mira_runs SET lane=NULL WHERE id=${run.id}`;
    const worker = {
        ...context,
        actor: `mira:${run.id}`,
        run: { id: run.id, leaseToken: run.leaseToken },
    };
    const pair = await api.computers.pair({ label: "Synthetic PC" });
    const device = await enrollMiraComputer(f.client, pair.token, {
        installationId: crypto.randomUUID(),
        platform: "win32",
        version: "0.10.0",
    });
    const connection = await connectMiraComputer(f.client, device.credential);
    const grant = await api.computers.access.request({
        computerId: pair.id,
        computerVersion: 2,
        runId: run.id,
        mode,
    });
    const binding = {
        accessId: grant.id,
        connectionId: connection.connectionId,
        targetId: crypto.randomUUID(),
    };
    await acceptMiraComputerAccess(f.client, device.credential, {
        id: grant.id,
        connectionId: binding.connectionId,
        targetId: binding.targetId,
    });
    const reserve = async (action = "observe") => {
        const id = crypto.randomUUID();
        await f.client`INSERT INTO mira_tool_receipts(id,run_id,call_id,tool,input_hash,state) VALUES(${id},${run.id},${crypto.randomUUID()},${action === "observe" ? "mira_computer_observe" : "mira_computer_input"},'synthetic','running')`;
        return id;
    };
    const enqueue = async (supplied?: unknown) => {
        const operation = supplied ?? { action: "observe" };
        const action = (operation as { action: string }).action;
        return enqueueMiraComputerCommand(worker, await reserve(action), operation);
    };
    const claim = () => claimMiraComputerCommand(f.client, device.credential, binding);
    const finish = (id: string, result: unknown) =>
        finishMiraComputerCommand(f.client, device.credential, {
            ...binding,
            commandId: id,
            result,
        });
    const permit = () =>
        permitMiraComputerAccessLocally(f.client, device.credential, {
            id: grant.id,
            connectionId: binding.connectionId,
            targetId: binding.targetId,
            mode,
        });
    return {
        ...f,
        api,
        context,
        chat,
        run,
        worker,
        pair,
        device,
        binding,
        reserve,
        enqueue,
        claim,
        finish,
        permit,
    };
}
const image = () => ({
    observationId: crypto.randomUUID(),
    width: 390,
    height: 110,
    content: [
        {
            type: "image" as const,
            mediaType: "image/png" as const,
            data: createVisualChallenge().data,
        },
    ],
});
const input = () => ({
    action: "type",
    observationId: crypto.randomUUID(),
    text: "private synthetic text",
});

async function row(f: Awaited<ReturnType<typeof session>>, id: string) {
    const [result] = await f.client<
        { state: string; payload: unknown; result: unknown }[]
    >`SELECT state,payload,result FROM mira_computer_commands WHERE id=${id}`;
    return result;
}

test("durable commands claim and consume exactly once across concurrent requests", async () => {
    const f = await session(await operationFixture());
    try {
        const queued = await f.enqueue();
        expect(await takeMiraComputerCommand(f.worker, queued.id)).toEqual({
            state: "queued",
        });
        await rejects(f.enqueue(), /busy/);
        const claims = await Promise.all(Array.from({ length: 8 }, () => f.claim()));
        const delivered = claims.flatMap((x) => (x.command ? [x.command] : []));
        expect(delivered).toHaveLength(1);
        expect(delivered[0]).toMatchObject({
            ...f.binding,
            commandId: queued.id,
            operation: { action: "observe" },
        });
        expect(delivered[0]!.validForMs).toBeGreaterThan(0);
        expect(delivered[0]!.validForMs).toBeLessThanOrEqual(10_000);
        expect(await row(f, queued.id)).toEqual({
            state: "claimed",
            payload: null,
            result: null,
        });
        expect(await f.claim()).toEqual({ command: null });
        const result = image();
        const completed = await Promise.all([
            f.finish(queued.id, result),
            f.finish(queued.id, result),
        ]);
        expect(completed.filter((x) => x.accepted)).toHaveLength(1);
        const consumed = await Promise.all([
            takeMiraComputerCommand(f.worker, queued.id),
            takeMiraComputerCommand(f.worker, queued.id),
        ]);
        expect(consumed).toContainEqual({ state: "completed", result });
        expect(consumed).toContainEqual({ state: "consumed" });
        expect(await row(f, queued.id)).toEqual({
            state: "consumed",
            payload: null,
            result: null,
        });
        await rejects(
            enqueueMiraComputerCommand(f.worker, queued.id, { action: "observe" }),
            /unavailable/
        );
        const next = await f.enqueue(input());
        expect(await f.claim()).toMatchObject({ command: { commandId: next.id } });
        expect(await f.finish(next.id, { effect: "partial" })).toMatchObject({
            accepted: true,
        });
        expect(await takeMiraComputerCommand(f.worker, next.id)).toEqual({
            state: "completed",
            result: { effect: "partial" },
        });
        const audits = await f.client<
            { action: string; target: string }[]
        >`SELECT action,target FROM mira_audit`;
        expect(JSON.stringify(audits)).not.toContain(result.content[0]!.data);
        expect(JSON.stringify(audits)).not.toContain(input().text);
    } finally {
        await f.close();
    }
});

test("admission requires the exact live worker receipt and view-only grants reject input", async () => {
    const f = await session(await operationFixture(), "operator", "view");
    try {
        const receipt = await f.reserve();
        for (const context of [
            f.context,
            { ...f.worker, owner: "other" },
            { ...f.worker, run: { id: f.run.id, leaseToken: crypto.randomUUID() } },
        ])
            await rejects(
                enqueueMiraComputerCommand(context, receipt, { action: "observe" })
            );
        await rejects(
            enqueueMiraComputerCommand(f.worker, crypto.randomUUID(), {
                action: "observe",
            }),
            /receipt/
        );
        await rejects(enqueueMiraComputerCommand(f.worker, receipt, input()), /receipt/);
        await rejects(f.enqueue(input()), /unavailable/);
        await f.client`UPDATE mira_tool_receipts SET state='unknown' WHERE id=${receipt}`;
        await rejects(
            enqueueMiraComputerCommand(f.worker, receipt, { action: "observe" }),
            /receipt/
        );
        const queued = await f.enqueue();
        expect(await f.claim()).toMatchObject({ command: { commandId: queued.id } });
        for (const context of [
            f.context,
            { ...f.worker, owner: "other" },
            { ...f.worker, run: { id: f.run.id, leaseToken: crypto.randomUUID() } },
        ])
            await rejects(takeMiraComputerCommand(context, queued.id));
    } finally {
        await f.close();
    }
});

test("device claims and completions cannot substitute another target, grant, generation or computer", async () => {
    const f = await session(await operationFixture());
    try {
        const queued = await f.enqueue();
        for (const field of ["accessId", "targetId"])
            expect(
                await claimMiraComputerCommand(f.client, f.device.credential, {
                    ...f.binding,
                    [field]: crypto.randomUUID(),
                })
            ).toEqual({ command: null });
        await rejects(
            claimMiraComputerCommand(f.client, f.device.credential, {
                ...f.binding,
                connectionId: crypto.randomUUID(),
            })
        );
        const other = await session(f, "other");
        expect(
            await claimMiraComputerCommand(f.client, other.device.credential, {
                ...f.binding,
                connectionId: other.binding.connectionId,
            })
        ).toEqual({ command: null });
        expect(await f.claim()).toMatchObject({ command: { commandId: queued.id } });
        for (const field of ["accessId", "targetId", "commandId"])
            expect(
                await finishMiraComputerCommand(f.client, f.device.credential, {
                    ...f.binding,
                    commandId: queued.id,
                    [field]: crypto.randomUUID(),
                    result: image(),
                })
            ).toMatchObject({ accepted: false });
        expect(
            await finishMiraComputerCommand(f.client, other.device.credential, {
                ...f.binding,
                connectionId: other.binding.connectionId,
                commandId: queued.id,
                result: image(),
            })
        ).toMatchObject({ accepted: false });
        expect(await f.finish(queued.id, image())).toMatchObject({ accepted: true });
    } finally {
        await f.close();
    }
});

test("expired delivery cannot be reclaimed and always scrubs transient content", async () => {
    for (const state of ["queued", "claimed", "completed"]) {
        const f = await session(await operationFixture());
        try {
            const queued = await f.enqueue(
                state === "queued" ? input() : { action: "observe" }
            );
            if (state !== "queued") await f.claim();
            if (state === "completed") await f.finish(queued.id, image());
            await f.client`UPDATE mira_computer_commands SET created_at=now()-interval '20 seconds',expires_at=now()-interval '10 seconds' WHERE id=${queued.id}`;
            expect(await f.claim()).toEqual({ command: null });
            const terminal = state === "queued" ? "refused" : "unknown";
            expect(await row(f, queued.id)).toEqual({
                state: terminal,
                payload: null,
                result: null,
            });
            expect(await takeMiraComputerCommand(f.worker, queued.id)).toEqual({
                state: terminal,
            });
            expect(await f.finish(queued.id, image())).toMatchObject({ accepted: false });
            await rejects(f.permit());
            await rejects(f.enqueue(), /unavailable/);
            expect(await cleanupMiraComputerCommands(f.client)).toBe(0);
        } finally {
            await f.close();
        }
    }
});

test("stop, reconnect and revoke immediately erase completed screenshots and input payloads", async () => {
    for (const reason of ["human", "local", "reconnect", "revoke"]) {
        const f = await session(await operationFixture());
        try {
            const queued = await f.enqueue();
            await f.claim();
            await f.finish(queued.id, image());
            if (reason === "human")
                await f.api.computers.access.stop({ id: f.binding.accessId });
            if (reason === "local")
                await stopMiraComputerAccessLocally(f.client, f.device.credential, {
                    id: f.binding.accessId,
                });
            if (reason === "reconnect")
                await connectMiraComputer(f.client, f.device.credential);
            if (reason === "revoke")
                await f.api.computers.revoke({ id: f.pair.id, version: 2 });
            expect(await row(f, queued.id)).toEqual({
                state: "unknown",
                payload: null,
                result: null,
            });
            await rejects(f.permit());
            await rejects(f.enqueue(), /unavailable/);
        } finally {
            await f.close();
        }
    }
});

test("run, tool receipt and account controls invalidate permits and periodic cleanup clears stranded data", async () => {
    for (const reason of ["cancel", "lease", "replacement", "receipt", "pause"]) {
        const f = await session(await operationFixture());
        try {
            const queued = await f.enqueue(input());
            await f.claim();
            if (reason === "cancel") await cancelRun(f.context, f.run.id);
            if (reason === "lease")
                await f.client`UPDATE mira_runs SET lease_expires_at=now()-interval '1 second' WHERE id=${f.run.id}`;
            if (reason === "replacement")
                await f.client`UPDATE mira_runs SET lease_token=${crypto.randomUUID()} WHERE id=${f.run.id}`;
            if (reason === "receipt")
                await f.client`UPDATE mira_tool_receipts SET state='unknown' WHERE id=${queued.id}`;
            if (reason === "pause")
                await f.client`INSERT INTO mira_switches(owner,key,enabled,version) VALUES(${f.context.owner},'autonomy',false,2) ON CONFLICT(owner,key) DO UPDATE SET enabled=false,version=mira_switches.version+1`;
            await rejects(f.permit());
            expect(await cleanupMiraComputerCommands(f.client)).toBe(1);
            expect(await row(f, queued.id)).toEqual({
                state: "unknown",
                payload: null,
                result: null,
            });
            expect(await cleanupMiraComputerCommands(f.client)).toBe(0);
        } finally {
            await f.close();
        }
    }
});

test("invalid or unknown native results never turn into confirmed completions", async () => {
    const f = await session(await operationFixture());
    try {
        const queued = await f.enqueue();
        await f.claim();
        const picture = image();
        for (const result of [
            { effect: "confirmed" },
            { ...picture, width: 1 },
            { ...picture, content: [{ type: "text", text: "injected" }] },
            { ...picture, path: "/native/path" },
        ])
            await rejects(f.finish(queued.id, result));
        expect(await row(f, queued.id)).toEqual({
            state: "claimed",
            payload: null,
            result: null,
        });
        await f.finish(queued.id, picture);
        await takeMiraComputerCommand(f.worker, queued.id);
        const next = await f.enqueue(input());
        await f.claim();
        expect(await f.finish(next.id, { effect: "unknown" })).toMatchObject({
            accepted: false,
        });
        expect(await takeMiraComputerCommand(f.worker, next.id)).toEqual({
            state: "unknown",
        });
        await rejects(f.permit());
    } finally {
        await f.close();
    }
});

test("private HTTP routes keep image budgets isolated and refuse browser credentials", async () => {
    const f = await session(await operationFixture());
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
    const post = (route: string, body: unknown, headers: Record<string, string> = {}) =>
        fetch(new URL(`/api/mira/computers/${route}`, privateOrigin), {
            method: "POST",
            headers: {
                authorization: `Bearer ${f.device.credential}`,
                "content-type": "application/json",
                ...headers,
            },
            body: JSON.stringify(body),
        });
    try {
        const queued = await f.enqueue();
        expect(
            await post("commands/claim", f.binding, {
                origin: "https://public.example.test",
            })
        ).toMatchObject({ status: 403 });
        expect(
            await post("commands/claim", f.binding, { cookie: "session=untrusted" })
        ).toMatchObject({ status: 403 });
        expect(
            await post("commands/claim", { ...f.binding, padding: "x".repeat(2048) })
        ).toMatchObject({ status: 400 });
        const claimed = await post("commands/claim", f.binding);
        expect(claimed.headers.get("cache-control")).toBe("no-store");
        expect(await claimed.json()).toMatchObject({ command: { commandId: queued.id } });
        const result = image();
        result.content[0]!.data = Buffer.concat([
            Buffer.from(result.content[0]!.data, "base64"),
            Buffer.alloc(1024 * 1024),
        ]).toString("base64");
        const body = { ...f.binding, commandId: queued.id, result };
        expect(await post("access/permit", body)).toMatchObject({ status: 400 });
        // Exercise the handler limit directly; the production listener also caps transport.
        expect(
            await miraComputerReceiver(f.client)(
                new Request(
                    new URL(
                        "/api/mira/computers/commands/finish",
                        privateOrigin
                    ).toString(),
                    {
                        method: "POST",
                        headers: {
                            authorization: `Bearer ${f.device.credential}`,
                            "content-type": "application/json",
                        },
                        body: JSON.stringify({
                            ...body,
                            padding: "x".repeat(3 * 1024 * 1024),
                        }),
                    }
                )
            )
        ).toMatchObject({ status: 400 });
        const finished = await post("commands/finish", body);
        expect(finished.status).toBe(200);
        expect(await finished.json()).toEqual({ commandId: queued.id, accepted: true });
        expect(await takeMiraComputerCommand(f.worker, queued.id)).toEqual({
            state: "completed",
            result,
        });
        expect(await post("commands/enqueue", {})).toMatchObject({ status: 404 });
    } finally {
        await server.stop(true);
        await f.close();
    }
});

test("per-access, account and global admission limits bound durable payload storage", async () => {
    const base = await operationFixture();
    try {
        const f = await session(base);
        for (let index = 0; index < 32; index++) {
            const queued = await f.enqueue(input());
            await f.claim();
            await f.finish(queued.id, { effect: "confirmed" });
            await takeMiraComputerCommand(f.worker, queued.id);
        }
        await rejects(f.enqueue(), /limit/);
        const owned = [];
        for (let index = 0; index < 8; index++) {
            const next = await session(base);
            owned.push(next);
            await next.enqueue();
        }
        const extra = await session(base);
        await rejects(extra.enqueue(), /limit/);
        for (let index = 0; index < 24; index++) {
            const next = await session(base, `other-${index}`);
            await next.enqueue();
        }
        const over = await session(base, "over-limit");
        await rejects(over.enqueue(), /limit/);
        const [count] = await base.client<
            { count: number }[]
        >`SELECT count(*)::int AS count FROM mira_computer_commands WHERE state IN ('queued','claimed','completed')`;
        expect(count?.count).toBe(32);
        for (const current of owned)
            await current.api.computers.access.stop({ id: current.binding.accessId });
        await over.enqueue();
    } finally {
        await base.close();
    }
}, 30_000);

test("run cancellation committed during dispatch or completion wins before content leaves the transaction", async () => {
    for (const phase of ["claim", "finish"]) {
        const f = await session(await operationFixture());
        const held = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        try {
            const queued = await f.enqueue();
            if (phase === "finish") await f.claim();
            const blocker = f.client.begin(async (query) => {
                await query`SELECT id FROM mira_runs WHERE id=${f.run.id} FOR UPDATE`;
                held.resolve();
                await release.promise;
                await query`UPDATE mira_runs SET cancel_requested=true WHERE id=${f.run.id}`;
            });
            await held.promise;
            const pending = phase === "claim" ? f.claim() : f.finish(queued.id, image());
            await Bun.sleep(10);
            release.resolve();
            await blocker;
            expect(await pending).toEqual(
                phase === "claim"
                    ? { command: null }
                    : { commandId: queued.id, accepted: false }
            );
            await cleanupMiraComputerCommands(f.client);
            expect(await row(f, queued.id)).toEqual({
                state: phase === "claim" ? "refused" : "unknown",
                payload: null,
                result: null,
            });
        } finally {
            release.resolve();
            await f.close();
        }
    }
});

test("receipt retirement during result consumption erases the frame instead of returning it", async () => {
    const f = await session(await operationFixture());
    const held = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    try {
        const queued = await f.enqueue();
        await f.claim();
        await f.finish(queued.id, image());
        const blocker = f.client.begin(async (query) => {
            await query`SELECT id FROM mira_tool_receipts WHERE id=${queued.id} FOR UPDATE`;
            held.resolve();
            await release.promise;
            await query`UPDATE mira_tool_receipts SET state='unknown' WHERE id=${queued.id}`;
        });
        await held.promise;
        const pending = takeMiraComputerCommand(f.worker, queued.id);
        await Bun.sleep(10);
        release.resolve();
        await blocker;
        expect(await pending).toEqual({ state: "unknown" });
        expect(await row(f, queued.id)).toEqual({
            state: "unknown",
            payload: null,
            result: null,
        });
    } finally {
        release.resolve();
        await f.close();
    }
});

test("deleting a stopped conversation scrubs any stranded command content", async () => {
    const f = await session(await operationFixture());
    try {
        const queued = await f.enqueue();
        await f.claim();
        await f.finish(queued.id, image());
        await f.client`UPDATE mira_runs SET state='interrupted',finished_at=clock_timestamp() WHERE id=${f.run.id}`;
        const [chat] = await f.client<
            { version: number }[]
        >`SELECT version FROM mira_conversations WHERE id=${f.chat.id}`;
        await f.api.conversations.change({
            id: f.chat.id,
            version: chat!.version,
            action: "delete",
        });
        expect(await row(f, queued.id)).toEqual({
            state: "unknown",
            payload: null,
            result: null,
        });
    } finally {
        await f.close();
    }
});

test("replacing an unavailable access immediately retires its outstanding content", async () => {
    const f = await session(await operationFixture());
    try {
        const queued = await f.enqueue();
        await f.claim();
        await f.finish(queued.id, image());
        await f.client`UPDATE mira_tool_receipts SET state='unknown' WHERE id=${queued.id}`;
        const next = await f.api.computers.access.request({
            computerId: f.pair.id,
            computerVersion: 2,
            runId: f.run.id,
            mode: "control",
        });
        expect(next.id).not.toBe(f.binding.accessId);
        expect(next.state).toBe("pending");
        expect(await row(f, queued.id)).toEqual({
            state: "unknown",
            payload: null,
            result: null,
        });
    } finally {
        await f.close();
    }
});

test("repeated stops scrub already-stopped access only for its owner and selected computer", async () => {
    for (const actor of ["human", "local", "other"]) {
        const f = await session(await operationFixture());
        try {
            const queued = await f.enqueue(input());
            // Simulate a stale-access path that stopped the grant before command cleanup ran.
            await f.client`UPDATE mira_computer_access SET state='stopped',stopped_at=clock_timestamp() WHERE id=${f.binding.accessId}`;
            if (actor === "human")
                await f.api.computers.access.stop({ id: f.binding.accessId });
            if (actor === "local")
                await stopMiraComputerAccessLocally(f.client, f.device.credential, {
                    id: f.binding.accessId,
                });
            if (actor === "other") {
                const other = await session(f);
                await stopMiraComputerAccessLocally(f.client, other.device.credential, {
                    id: f.binding.accessId,
                });
                expect(await row(f, queued.id)).toMatchObject({
                    state: "queued",
                    payload: { action: "type", text: "private synthetic text" },
                });
                await f.api.computers.access.stop({ id: f.binding.accessId });
            }
            expect(await row(f, queued.id)).toEqual({
                state: "refused",
                payload: null,
                result: null,
            });
            await f.api.computers.access.stop({ id: f.binding.accessId });
            expect(await row(f, queued.id)).toEqual({
                state: "refused",
                payload: null,
                result: null,
            });
        } finally {
            await f.close();
        }
    }
});
