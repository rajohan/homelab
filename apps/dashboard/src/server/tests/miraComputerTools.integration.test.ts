import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";

import { capabilities } from "@homelab/contracts/operations";
import { acceptMiraComputerAccess } from "@homelab/mira/data/computerAccess";
import {
    abandonMiraComputerCommand,
    claimMiraComputerCommand,
    finishMiraComputerCommand,
    finalizeMiraComputerCommand,
    takeMiraComputerCommand,
} from "@homelab/mira/data/computerCommands";
import { connectMiraComputer, enrollMiraComputer } from "@homelab/mira/data/computers";
import { claimMiraRun } from "@homelab/mira/data/queue";

import { createMiraTools } from "../../../../mira/src/server/executor/tools";
import {
    runtimeContentItems,
    type RuntimeToolResult,
} from "../../../../mira/src/server/runtime/toolResult";
import { createVisualChallenge } from "../../../../mira/src/server/testing/visualChallenge";
import { appRouter } from "../api/router";
import { operationFixture } from "../testing/operations";

async function fixture(mode: "view" | "control" = "control", accepted = true) {
    const f = await operationFixture();
    const principal = { kind: "human" as const, id: "operator", capabilities };
    const api = appRouter.createCaller({
        operations: f,
        principal,
        verifyHuman: () => Promise.resolve(principal),
    }).mira;
    const chat = await api.conversations.create({ title: "Synthetic visual tool" });
    await api.conversations.send({
        conversationId: chat.id,
        requestId: crypto.randomUUID(),
        text: "Inspect the synthetic window.",
    });
    const run = await claimMiraRun(f.client, crypto.randomUUID(), "foreground");
    if (!run) throw new Error("Expected synthetic run.");
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
    if (accepted)
        await acceptMiraComputerAccess(f.client, device.credential, {
            id: grant.id,
            connectionId: binding.connectionId,
            targetId: binding.targetId,
        });
    const controller = new AbortController();
    const tools = createMiraTools(f.client, run);
    const invoke = (
        name: string,
        input: unknown,
        callId = crypto.randomUUID(),
        selected = tools
    ) =>
        selected
            .find((tool) => tool.name === name)!
            .execute(input, controller.signal, {
                callId,
                threadId: "synthetic",
                turnId: "synthetic",
            });
    const worker = {
        client: f.client,
        owner: run.owner,
        actor: `mira:${run.id}`,
        run: { id: run.id, leaseToken: run.leaseToken },
    };
    const queued = async () => {
        for (let i = 0; i < 200; i++) {
            const [row] = await f.client<
                { id: string }[]
            >`SELECT id FROM mira_computer_commands WHERE run_id=${run.id} ORDER BY created_at DESC LIMIT 1`;
            if (row) return row.id;
            await Bun.sleep(10);
        }
        throw new Error("Synthetic command did not arrive.");
    };
    const claim = async () => {
        await queued();
        const { command } = await claimMiraComputerCommand(
            f.client,
            device.credential,
            binding
        );
        if (!command) throw new Error("Expected one claimed command.");
        return command;
    };
    const finish = (id: string, result: unknown) =>
        finishMiraComputerCommand(f.client, device.credential, {
            ...binding,
            commandId: id,
            result,
        });
    return {
        ...f,
        api,
        run,
        binding,
        device,
        controller,
        tools,
        invoke,
        worker,
        queued,
        claim,
        finish,
    };
}
function text(result: RuntimeToolResult) {
    expect(typeof result).toBe("string");
    return JSON.parse(result as string) as {
        ok: boolean;
        retryable?: boolean;
        message?: string;
        result?: { effect: string };
    };
}
const frame = () => ({
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
    action: "type" as const,
    observationId: crypto.randomUUID(),
    text: "synthetic private input",
});
async function retired(f: Awaited<ReturnType<typeof fixture>>, id: string) {
    const [row] = await f.client<
        {
            state: string;
            payload: unknown;
            result: unknown;
            access: string;
            receipt: string;
        }[]
    >`SELECT c.state,c.payload,c.result,g.state AS access,r.state AS receipt FROM mira_computer_commands c JOIN mira_computer_access g ON g.id=c.access_id JOIN mira_tool_receipts r ON r.id=c.id WHERE c.id=${id}`;
    expect(row).toMatchObject({
        payload: null,
        result: null,
        access: "stopped",
        receipt: "unknown",
    });
    expect(
        await claimMiraComputerCommand(f.client, f.device.credential, f.binding)
    ).toEqual({ command: null });
}

test("computer observation uses the real receipt router and structured runtime image protocol", async () => {
    const f = await fixture("view");
    try {
        const callId = crypto.randomUUID();
        const pending = f.invoke("mira_computer_observe", {}, callId);
        const command = await f.claim();
        expect(command.operation).toEqual({ action: "observe" });
        const result = frame();
        expect(await f.finish(command.commandId, result)).toMatchObject({
            accepted: true,
        });
        const output = await pending;
        const items = runtimeContentItems(output);
        expect(items).toHaveLength(2);
        expect(items[0]!.type).toBe("inputText");
        expect(items[0]).toMatchObject({
            text: expect.stringContaining(result.observationId) as unknown,
        });
        expect(items[0]).toMatchObject({
            text: expect.not.stringContaining(result.content[0]!.data) as unknown,
        });
        expect(items[1]).toEqual({
            type: "inputImage",
            imageUrl: `data:image/png;base64,${result.content[0]!.data}`,
        });
        const [row] = await f.client<
            { state: string; payload: unknown; result: unknown; receipt: string }[]
        >`SELECT c.state,c.payload,c.result,r.state AS receipt FROM mira_computer_commands c JOIN mira_tool_receipts r ON r.id=c.id WHERE c.id=${command.commandId}`;
        expect(row).toEqual({
            state: "consumed",
            payload: null,
            result: null,
            receipt: "succeeded",
        });
        const duplicate = text(
            await f.invoke(
                "mira_computer_observe",
                {},
                callId,
                createMiraTools(f.client, f.run)
            )
        );
        expect(duplicate).toMatchObject({
            ok: false,
            message: expect.stringContaining("not replayed") as unknown,
        });
        expect(await f.client`SELECT id FROM mira_computer_commands`).toHaveLength(1);
    } finally {
        await f.close();
    }
});

test("computer input preserves confirmed, partial, unverified and refused effects without retries", async () => {
    for (const effect of ["confirmed", "partial", "unverified", "refused"]) {
        const f = await fixture();
        try {
            const operation = input();
            const callId = crypto.randomUUID();
            const pending = f.invoke("mira_computer_input", operation, callId);
            const command = await f.claim();
            expect(command.operation).toEqual(operation);
            await f.finish(command.commandId, { effect });
            expect(text(await pending)).toEqual({ ok: true, result: { effect } });
            expect(
                text(await f.invoke("mira_computer_input", operation, callId))
            ).toMatchObject({
                ok: false,
                message: expect.stringContaining("not replayed") as unknown,
            });
            expect(await f.client`SELECT id FROM mira_computer_commands`).toHaveLength(1);
        } finally {
            await f.close();
        }
    }
});

test("computer tools cannot choose targets, approve pending access, widen view grants or run automatically", async () => {
    for (const accepted of [true, false]) {
        const f = await fixture("view", accepted);
        try {
            expect(
                text(
                    await f.invoke("mira_computer_observe", {
                        targetId: f.binding.targetId,
                    })
                )
            ).toMatchObject({ ok: false, retryable: true });
            expect(text(await f.invoke("mira_computer_input", input()))).toMatchObject({
                ok: false,
                retryable: true,
            });
            const automatic = createMiraTools(f.client, {
                ...f.run,
                automationId: crypto.randomUUID(),
            });
            expect(
                text(
                    await f.invoke(
                        "mira_computer_observe",
                        {},
                        crypto.randomUUID(),
                        automatic
                    )
                )
            ).toMatchObject({
                ok: false,
                message: expect.stringContaining("automatic run") as unknown,
            });
            if (!accepted)
                expect(text(await f.invoke("mira_computer_observe", {}))).toMatchObject({
                    ok: false,
                    retryable: true,
                });
            expect(await f.client`SELECT id FROM mira_computer_commands`).toHaveLength(0);
        } finally {
            await f.close();
        }
    }
});

test("computer cancellation retires queued and claimed work and latches uncertainty for later calls", async () => {
    for (const delivered of [false, true]) {
        const f = await fixture();
        try {
            const pending = f.invoke("mira_computer_input", input());
            const claimed = delivered ? await f.claim() : undefined;
            const id = claimed ? claimed.commandId : await f.queued();
            f.controller.abort(new Error("synthetic cancellation"));
            expect(text(await pending)).toMatchObject({ ok: false, retryable: false });
            await retired(f, id);
            const [row] = await f.client<
                { state: string }[]
            >`SELECT state FROM mira_computer_commands WHERE id=${id}`;
            expect(row!.state).toBe(delivered ? "unknown" : "refused");
            const other = f.tools.find((tool) => tool.name === "mira_tasks_list")!;
            expect(
                text(
                    await other.execute({}, new AbortController().signal, {
                        callId: crypto.randomUUID(),
                        threadId: "synthetic",
                        turnId: "synthetic",
                    })
                )
            ).toMatchObject({
                ok: false,
                retryable: false,
                message: expect.stringContaining("earlier action") as unknown,
            });
            expect(await f.finish(id, { effect: "confirmed" })).toMatchObject({
                accepted: false,
            });
        } finally {
            await f.close();
        }
    }
});

test("computer unknown delivery and malformed stored frames cannot become successful or retryable tool results", async () => {
    for (const malformed of [false, true]) {
        const f = await fixture();
        try {
            const pending = f.invoke(
                malformed ? "mira_computer_observe" : "mira_computer_input",
                malformed ? {} : input()
            );
            const command = await f.claim();
            await (malformed
                ? f.client`UPDATE mira_computer_commands SET state='completed',result='{"content":[]}'::jsonb WHERE id=${command.commandId}`
                : f.finish(command.commandId, { effect: "unknown" }));
            expect(text(await pending)).toMatchObject({ ok: false, retryable: false });
            await retired(f, command.commandId);
        } finally {
            await f.close();
        }
    }
});

test("computer final delivery fence drops consumed frames if access stops before receipt success", async () => {
    const f = await fixture();
    try {
        await f.client.unsafe(
            `CREATE FUNCTION stop_after_consumption() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='consumed' THEN UPDATE mira_computer_access SET state='stopped',stopped_at=clock_timestamp() WHERE id=NEW.access_id; END IF; RETURN NEW; END $$`
        );
        await f.client.unsafe(
            `CREATE TRIGGER stop_after_consumption AFTER UPDATE ON mira_computer_commands FOR EACH ROW EXECUTE FUNCTION stop_after_consumption()`
        );
        const pending = f.invoke("mira_computer_observe", {});
        const command = await f.claim();
        await f.finish(command.commandId, frame());
        expect(text(await pending)).toMatchObject({ ok: false, retryable: false });
        await retired(f, command.commandId);
    } finally {
        await f.close();
    }
});

test("computer final receipt failure retires access even after a confirmed input was consumed", async () => {
    const f = await fixture();
    try {
        await f.client.unsafe(
            `CREATE FUNCTION fail_computer_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='succeeded' THEN RAISE EXCEPTION 'synthetic lost receipt commit'; END IF; RETURN NEW; END $$`
        );
        await f.client.unsafe(
            `CREATE TRIGGER fail_computer_receipt BEFORE UPDATE ON mira_tool_receipts FOR EACH ROW EXECUTE FUNCTION fail_computer_receipt()`
        );
        const callId = crypto.randomUUID();
        const pending = f.invoke("mira_computer_input", input(), callId);
        const command = await f.claim();
        await f.finish(command.commandId, { effect: "confirmed" });
        expect(text(await pending)).toMatchObject({ ok: false, retryable: false });
        await retired(f, command.commandId);
        expect(
            text(
                await f.invoke(
                    "mira_computer_input",
                    input(),
                    callId,
                    createMiraTools(f.client, f.run)
                )
            )
        ).toMatchObject({
            ok: false,
            message: expect.stringContaining("not replayed") as unknown,
        });
    } finally {
        await f.close();
    }
});

test("computer retirement cannot stop another owner's or another lease's accepted session", async () => {
    const f = await fixture();
    try {
        const pending = f.invoke("mira_computer_observe", {});
        const command = await f.claim();
        await abandonMiraComputerCommand(
            { ...f.worker, owner: "other" },
            command.commandId
        );
        await abandonMiraComputerCommand(
            { ...f.worker, run: { ...f.worker.run, leaseToken: crypto.randomUUID() } },
            command.commandId
        );
        await f.finish(command.commandId, frame());
        expect(runtimeContentItems(await pending)[1]!.type).toBe("inputImage");
    } finally {
        await f.close();
    }
});

test("computer consumed result loss is never reconstructed or replayed by a waiting executor", async () => {
    const f = await fixture();
    try {
        const pending = f.invoke("mira_computer_observe", {});
        const command = await f.claim();
        // A deterministic competing consumer runs inside completion's transaction via a trigger.
        await f.client.unsafe(
            `CREATE FUNCTION lose_computer_result() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.state='completed' THEN NEW.state='consumed'; NEW.result=NULL; END IF; RETURN NEW; END $$`
        );
        await f.client.unsafe(
            `CREATE TRIGGER lose_computer_result BEFORE UPDATE ON mira_computer_commands FOR EACH ROW EXECUTE FUNCTION lose_computer_result()`
        );
        await f.finish(command.commandId, frame());
        expect(await takeMiraComputerCommand(f.worker, command.commandId)).toEqual({
            state: "consumed",
        });
        expect(text(await pending)).toMatchObject({ ok: false, retryable: false });
        await retired(f, command.commandId);
    } finally {
        await f.close();
    }
});

test("computer finalization rechecks deadlines after waiting for the receipt lock", async () => {
    const f = await fixture();
    try {
        // Reserve a real receipt without a competing polling worker for this lock-order test.
        const id = crypto.randomUUID();
        await f.client`INSERT INTO mira_tool_receipts(id,run_id,call_id,tool,input_hash,state) VALUES(${id},${f.run.id},${crypto.randomUUID()},'mira_computer_observe','synthetic','running')`;
        await f.client`INSERT INTO mira_computer_commands(id,owner,access_id,run_id,run_lease,connection_id,target_id,action,state,created_at,expires_at) VALUES(${id},${f.run.owner},${f.binding.accessId},${f.run.id},${f.run.leaseToken},${f.binding.connectionId},${f.binding.targetId},'observe','consumed',clock_timestamp()-interval '1 second',clock_timestamp()+interval '10 seconds')`;
        const locked = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const holder = f.client.begin(async (query) => {
            await query`SELECT id FROM mira_tool_receipts WHERE id=${id} FOR UPDATE`;
            locked.resolve();
            await release.promise;
            await query`UPDATE mira_computer_commands SET expires_at=clock_timestamp()-interval '100 milliseconds' WHERE id=${id}`;
        });
        await locked.promise;
        const finalizing = finalizeMiraComputerCommand(f.worker, id, f.controller.signal);
        const rejected = rejects(finalizing, /lost its authority/);
        try {
            let waiting = false;
            for (let attempt = 0; attempt < 100; attempt++) {
                const [activity] = await f.client<
                    { waiting: boolean }[]
                >`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE '%mira_tool_receipts%' AND pid<>pg_backend_pid()) AS waiting`;
                if (activity!.waiting) {
                    waiting = true;
                    break;
                }
                await Bun.sleep(10);
            }
            expect(waiting).toBe(true);
        } finally {
            release.resolve();
            await holder;
        }
        await rejected;
        const [receipt] = await f.client<
            { state: string }[]
        >`SELECT state FROM mira_tool_receipts WHERE id=${id}`;
        expect(receipt!.state).toBe("running");
    } finally {
        await f.close();
    }
});
