import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";

import { miraComputerCommandLimit } from "@homelab/contracts/miraComputerCommands";
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

import { version } from "../../../../../package.json";
import { createVisualChallenge } from "../../../../mira/src/server/testing/visualChallenge";
import { appRouter } from "../api/router";
import { startDashboardServer } from "../index";
import { miraComputerReceiver } from "../mira/computerReceiver";
import { operationFixture } from "../testing/operations";

async function session(
    f: Awaited<ReturnType<typeof operationFixture>>,
    owner = "operator",
    mode: "view" | "control" = "control",
    keepOpen = false
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
    const connection = await connectMiraComputer(f.client, device.credential, {
        version,
    });
    const grant = await api.computers.access.request({
        computerId: pair.id,
        computerVersion: 2,
        runId: run.id,
        mode,
        keepOpen,
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

test("persistent consent delivers commands for the next manual reply without reusing an old run or receipt", async () => {
    const f = await session(await operationFixture(), "operator", "control", true);
    try {
        const first = await f.enqueue();
        await f.claim();
        const firstFrame = image();
        await f.finish(first.id, firstFrame);
        await takeMiraComputerCommand(f.worker, first.id);
        await f.client`UPDATE mira_runs SET state='completed',lease_token=NULL,lease_expires_at=NULL WHERE id=${f.run.id}`;
        const between = await f.permit();
        expect(between.validForMs).toBeGreaterThan(0);
        await rejects(f.enqueue());
        await f.api.conversations.send({
            conversationId: f.chat.id,
            requestId: crypto.randomUUID(),
            text: "Next coaching question",
            attachmentIds: [],
        });
        const next = await claimMiraRun(f.client, crypto.randomUUID(), "foreground");
        if (!next) throw new Error("Expected a follow-up run");
        const worker = {
            ...f.worker,
            actor: `mira:${next.id}`,
            run: { id: next.id, leaseToken: next.leaseToken },
        };
        await rejects(
            enqueueMiraComputerCommand(worker, first.id, { action: "observe" }),
            /receipt/
        );
        const id = crypto.randomUUID();
        await f.client`INSERT INTO mira_tool_receipts(id,run_id,call_id,tool,input_hash,state) VALUES(${id},${next.id},${crypto.randomUUID()},'mira_computer_observe','synthetic','running')`;
        await f.client`UPDATE mira_runs SET manual=false WHERE id=${next.id}`;
        await rejects(
            enqueueMiraComputerCommand(worker, id, { action: "observe" }),
            /unavailable/
        );
        await f.client`UPDATE mira_runs SET manual=true WHERE id=${next.id}`;
        const inputId = crypto.randomUUID();
        await f.client`INSERT INTO mira_tool_receipts(id,run_id,call_id,tool,input_hash,state) VALUES(${inputId},${next.id},${crypto.randomUUID()},'mira_computer_input','synthetic','running')`;
        await rejects(
            enqueueMiraComputerCommand(worker, inputId, {
                action: "type",
                observationId: firstFrame.observationId,
                text: "Old reply frame",
            }),
            /fresh computer observation in this run/
        );
        expect(await f.claim()).toEqual({ command: null });
        const permit = await f.permit();
        expect(permit.validForMs).toBeGreaterThan(0);
        await enqueueMiraComputerCommand(worker, id, { action: "observe" });
        expect(await f.claim()).toMatchObject({ command: { commandId: id } });
        const nextFrame = image();
        expect(await f.finish(id, nextFrame)).toMatchObject({ accepted: true });
        expect(await takeMiraComputerCommand(worker, id)).toMatchObject({
            state: "completed",
        });
        await rejects(takeMiraComputerCommand(f.worker, id));
        await enqueueMiraComputerCommand(worker, inputId, {
            action: "type",
            observationId: nextFrame.observationId,
            text: "Current reply frame",
        });
        expect(await f.claim()).toMatchObject({ command: { commandId: inputId } });
        expect(await f.finish(inputId, { effect: "confirmed" })).toMatchObject({
            accepted: true,
        });
        expect(await takeMiraComputerCommand(worker, inputId)).toMatchObject({
            result: { effect: "confirmed" },
        });
    } finally {
        await f.close();
    }
});

test("retained access refuses its lifetime command ceiling before claiming an uncertain operation", async () => {
    const f = await session(await operationFixture(), "operator", "control", true);
    try {
        await f.client`WITH receipts AS (
            INSERT INTO mira_tool_receipts(id,run_id,call_id,tool,input_hash,state)
            SELECT gen_random_uuid(),${f.run.id},gen_random_uuid()::text,'mira_computer_observe','synthetic','succeeded'
            FROM generate_series(1,${miraComputerCommandLimit - 1}) RETURNING id
        ) INSERT INTO mira_computer_commands(id,owner,access_id,run_id,run_lease,connection_id,target_id,action,state,created_at,expires_at)
            SELECT id,${f.context.owner},${f.binding.accessId},${f.run.id},${f.run.leaseToken},${f.binding.connectionId},${f.binding.targetId},'observe','consumed',statement_timestamp(),statement_timestamp()+interval '15 seconds' FROM receipts`;
        await f.client`UPDATE mira_runs SET state='completed',lease_token=NULL,lease_expires_at=NULL WHERE id=${f.run.id}`;
        await f.api.conversations.send({
            conversationId: f.chat.id,
            requestId: crypto.randomUUID(),
            text: "Next reply",
            attachmentIds: [],
        });
        const next = await claimMiraRun(f.client, crypto.randomUUID(), "foreground");
        if (!next) throw new Error("Expected a follow-up run");
        const worker = { ...f.worker, run: { id: next.id, leaseToken: next.leaseToken } };
        const reserve = async () => {
            const id = crypto.randomUUID();
            await f.client`INSERT INTO mira_tool_receipts(id,run_id,call_id,tool,input_hash,state) VALUES(${id},${next.id},${crypto.randomUUID()},'mira_computer_observe','synthetic','running')`;
            return id;
        };
        const last = await reserve();
        await enqueueMiraComputerCommand(worker, last, { action: "observe" });
        expect(await f.claim()).toMatchObject({ command: { commandId: last } });
        await f.finish(last, image());
        await takeMiraComputerCommand(worker, last);
        const excess = await reserve();
        await rejects(
            enqueueMiraComputerCommand(worker, excess, { action: "observe" }),
            /command limit/
        );
        expect(await row(f, excess)).toBeUndefined();
        expect(await f.claim()).toEqual({ command: null });
        const permit = await f.permit();
        expect(permit.validForMs).toBeGreaterThan(0);
    } finally {
        await f.close();
    }
});

test.each(["queued", "claimed", "completed"])(
    "persistent consent refuses %s command content after its current run ends",
    async (state) => {
        const f = await session(await operationFixture(), "operator", "control", true);
        try {
            const pending = await f.enqueue();
            if (state !== "queued") await f.claim();
            if (state === "completed") await f.finish(pending.id, image());
            await f.client`UPDATE mira_runs SET state='completed',lease_token=NULL,lease_expires_at=NULL WHERE id=${f.run.id}`;
            expect(await f.claim()).toEqual({ command: null });
            await rejects(f.permit());
            expect(await row(f, pending.id)).toMatchObject({
                payload: null,
                result: null,
                state: state === "queued" ? "refused" : "unknown",
            });
        } finally {
            await f.close();
        }
    }
);

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
        const queued = await f.enqueue(input());
        await rejects(f.enqueue(), /limit/);
        await f.claim();
        await f.finish(queued.id, { effect: "confirmed" });
        await takeMiraComputerCommand(f.worker, queued.id);
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

test("manual work and live assistance continue beyond 32 commands while live assistance keeps its per-minute limit", async () => {
    const f = await session(await operationFixture());
    try {
        await f.client`UPDATE mira_runs SET settings=jsonb_set(settings,'{liveAssistanceMinutes}','60') WHERE id=${f.run.id}`;
        for (let index = 0; index < 32; index++) {
            const queued = await f.enqueue();
            await f.claim();
            await f.finish(queued.id, image());
            await takeMiraComputerCommand(f.worker, queued.id);
        }
        await rejects(f.enqueue(), /limit/);
        await f.client`UPDATE mira_computer_commands SET created_at=created_at-interval '2 minutes',expires_at=expires_at-interval '2 minutes',claimed_at=claimed_at-interval '2 minutes',finished_at=finished_at-interval '2 minutes' WHERE access_id=${f.binding.accessId}`;
        const continued = await f.enqueue();
        await f.claim();
        await f.finish(continued.id, image());
        await takeMiraComputerCommand(f.worker, continued.id);
        await f.client`UPDATE mira_runs SET settings=jsonb_set(settings,'{liveAssistanceMinutes}','0') WHERE id=${f.run.id}`;
        const manual = await f.enqueue();
        await f.claim();
        expect(await f.finish(manual.id, image())).toMatchObject({ accepted: true });
        const outcome = await takeMiraComputerCommand(f.worker, manual.id);
        expect(outcome.state).toBe("completed");
    } finally {
        await f.close();
    }
});

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

test("element observations and input survive the durable queue with one-use content and scope", async () => {
    const f = await session(await operationFixture());
    try {
        const observation = {
            ...image(),
            coordinateInput: false,
            elements: [
                { token: "s00000001:2", role: "button", label: "Synthetic button" },
            ],
        };
        const read = await f.enqueue();
        await f.claim();
        expect(await f.finish(read.id, observation)).toEqual({
            commandId: read.id,
            accepted: true,
        });
        expect(await takeMiraComputerCommand(f.worker, read.id)).toEqual({
            state: "completed",
            result: observation,
        });
        const operation = {
            action: "click_element",
            observationId: observation.observationId,
            elementToken: observation.elements[0]!.token,
        };
        const queued = await f.enqueue(operation);
        expect(await f.claim()).toMatchObject({
            command: { commandId: queued.id, operation },
        });
        expect(await row(f, queued.id)).toEqual({
            state: "claimed",
            payload: null,
            result: null,
        });
        await f.finish(queued.id, { effect: "unverified" });
        expect(await takeMiraComputerCommand(f.worker, queued.id)).toEqual({
            state: "completed",
            result: { effect: "unverified" },
        });
        expect(await takeMiraComputerCommand(f.worker, queued.id)).toEqual({
            state: "consumed",
        });
        await rejects(f.enqueue({ ...operation, elementToken: "1" }));
        await rejects(f.enqueue({ ...operation, windowId: "999" }));
        const viewer = await session(f, "viewer", "view");
        await rejects(viewer.enqueue(operation), /unavailable/);
    } finally {
        await f.close();
    }
});
