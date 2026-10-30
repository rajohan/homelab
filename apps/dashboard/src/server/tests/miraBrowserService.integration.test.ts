import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { lockBrowserOwner } from "@homelab/mira/data/browserAccess";
import {
    abandonMiraBrowserCommand,
    claimMiraBrowserCommand,
    cleanupMiraBrowserCommands,
    enqueueMiraBrowserCommand,
    finalizeMiraBrowserCommand,
    finishMiraBrowserCommand,
    takeMiraBrowserCommand,
} from "@homelab/mira/data/browserCommands";
import { saveBrowserPreview } from "@homelab/mira/data/browserConsole";
import { claimBrowserHumanCommand } from "@homelab/mira/data/browserConsoleHost";
import { openMiraBrowserSession } from "@homelab/mira/data/browserHost";
import { readMiraBrowserReadiness } from "@homelab/mira/data/browserReadiness";
import {
    runMiraBrowserHost,
    type MiraBrowserHealth,
} from "@homelab/mira/data/browserService";
import { saveMiraFile } from "@homelab/mira/data/files";

import { createMiraTools } from "../../../../mira/src/server/executor/tools";
import {
    runtimeContentItems,
    maximumToolTextBytes,
    type RuntimeToolResult,
} from "../../../../mira/src/server/runtime/toolResult";
import { browserHostFixture } from "../testing/miraBrowserHost";

async function fixture(mode: "view" | "control" = "control") {
    const f = await browserHostFixture();
    const toolLifetime = new AbortController();
    const hostLifetime = new AbortController();
    const tools = createMiraTools(f.client, f.run);
    const health: MiraBrowserHealth = {
        ready: false,
        heartbeatAt: 0,
        active: 0,
        unresolved: 0,
    };
    let host: Promise<void> | undefined;
    return {
        ...f,
        health,
        tools,
        toolLifetime,
        hostLifetime,
        grant: () => f.api.browser.request({ ...f.request, mode }),
        start: (filesDirectory?: string) => {
            host = runMiraBrowserHost({
                client: f.client,
                configuration: f.config,
                signal: hostLifetime.signal,
                health,
                filesDirectory,
            });
            return host;
        },
        invoke: (name: string, input: unknown, callId = crypto.randomUUID()) =>
            tools
                .find((tool) => tool.name === name)!
                .execute(input, toolLifetime.signal, {
                    callId,
                    turnId: "synthetic",
                    threadId: "synthetic",
                }),
        stop: async () => {
            hostLifetime.abort();
            await host;
        },
        close: async () => {
            toolLifetime.abort();
            hostLifetime.abort();
            await host;
            await f.close();
        },
    };
}
async function until(check: () => boolean | Promise<boolean>) {
    for (let attempt = 0; attempt < 400; attempt++) {
        if (await check()) return;
        await Bun.sleep(10);
    }
    throw new Error("Synthetic browser condition did not settle.");
}
function text(output: RuntimeToolResult) {
    expect(typeof output).toBe("string");
    return JSON.parse(output as string) as {
        ok: boolean;
        retryable?: boolean;
        result?: { effect?: string; url?: string };
        message?: string;
    };
}
function frame(output: RuntimeToolResult) {
    if (typeof output === "string") throw new Error("Expected structured browser image.");
    const first = output.content[0];
    if (first?.type !== "text") throw new Error("Expected browser metadata.");
    expect(output.content[1]?.type).toBe("image");
    return (
        JSON.parse(first.text) as {
            result: { observationId: string; refs: { ref: string }[] };
        }
    ).result;
}
async function reserve(
    f: Awaited<ReturnType<typeof fixture>>,
    tool = "mira_browser_navigate"
) {
    const id = crypto.randomUUID();
    await f.client`INSERT INTO mira_tool_receipts(id,run_id,call_id,tool,input_hash,state) VALUES(${id},${f.run.id},${crypto.randomUUID()},${tool},'synthetic','running')`;
    return id;
}

test("Chat tools traverse the durable queue, real Unix Docker transport and guarded browser session", async () => {
    const f = await fixture();
    try {
        expect(await readMiraBrowserReadiness(f.worker)).toEqual({ state: "waiting" });
        const grant = await f.grant();
        void f.start();
        const observation = frame(await f.invoke("mira_browser_observe", {}));
        expect(observation.refs).toHaveLength(1);
        const input = {
            action: "click",
            observationId: observation.observationId,
            ref: observation.refs[0]!.ref,
        };
        const call = crypto.randomUUID();
        expect(text(await f.invoke("mira_browser_input", input, call)).result).toEqual({
            effect: "unverified",
        });
        expect(text(await f.invoke("mira_browser_input", input, call)).ok).toBe(false);
        expect(f.engine.events.filter((event) => event === "act")).toHaveLength(1);
        expect(
            text(
                await f.invoke("mira_browser_navigate", {
                    url: "https://example.test/next",
                })
            ).result
        ).toEqual({ url: "https://example.test/next" });
        const rows = await f.client<
            { state: string; payload: unknown; result: unknown }[]
        >`SELECT state,payload,result FROM mira_browser_commands ORDER BY created_at`;
        expect(rows).toHaveLength(3);
        expect(
            rows.every(
                (row) =>
                    row.state === "consumed" &&
                    row.payload === null &&
                    row.result === null
            )
        ).toBe(true);
        await f.api.browser.stop({ id: grant.id });
        await until(async () => {
            const grants = await f.api.browser.list({ runId: f.run.id });
            return grants[0]?.state === "closed";
        });
        expect(f.engine.exists).toBe(false);
        expect(await readMiraBrowserReadiness(f.worker)).toEqual({ state: "stopped" });
    } finally {
        await f.close();
    }
});

test("view-only grants refuse input and foreign origins before native dispatch", async () => {
    const f = await fixture("view");
    try {
        await f.grant();
        void f.start();
        const observed = frame(await f.invoke("mira_browser_observe", {}));
        expect(
            text(
                await f.invoke("mira_browser_input", {
                    action: "click",
                    observationId: observed.observationId,
                    ref: observed.refs[0]!.ref,
                })
            ).ok
        ).toBe(false);
        const refused = text(
            await f.invoke("mira_browser_navigate", { url: "https://foreign.test" })
        );
        expect(refused).toMatchObject({ ok: false, retryable: true });
        frame(await f.invoke("mira_browser_observe", {}));
        expect(
            f.engine.events.filter((event) => event === "act" || event === "navigate")
        ).toHaveLength(0);
    } finally {
        await f.close();
    }
});

test("cancelling dispatched input stops the browser and never retries the uncertain action", async () => {
    const f = await fixture();
    try {
        await f.grant();
        void f.start();
        const observed = frame(await f.invoke("mira_browser_observe", {}));
        f.engine.holdInput = true;
        const pending = f.invoke("mira_browser_input", {
            action: "click",
            observationId: observed.observationId,
            ref: observed.refs[0]!.ref,
        });
        await until(() => f.engine.events.includes("act"));
        f.toolLifetime.abort();
        expect(text(await pending)).toMatchObject({ ok: false, retryable: false });
        await until(() => !f.engine.exists);
        const [row] = await f.client<
            { state: string; payload: unknown; result: unknown }[]
        >`SELECT state,payload,result FROM mira_browser_commands WHERE method='act'`;
        expect(row).toEqual({ state: "unknown", payload: null, result: null });
        expect(f.engine.events.filter((event) => event === "act")).toHaveLength(1);
    } finally {
        await f.close();
    }
});

test("service shutdown drains active browser work and leaves no replayable command", async () => {
    const f = await fixture();
    try {
        await f.grant();
        void f.start();
        frame(await f.invoke("mira_browser_observe", {}));
        expect(f.engine.exists).toBe(true);
        await f.stop();
        expect(f.engine.exists).toBe(false);
        expect(f.health.ready).toBe(false);
        expect(f.health.active).toBe(0);
        const [row] = await f.client<
            { state: string }[]
        >`SELECT state FROM mira_browser_processes`;
        expect(row?.state).toBe("removed");
    } finally {
        await f.close();
    }
});

test("a competing host that loses the grant cannot stop the winning browser", async () => {
    const f = await fixture();
    let session: Awaited<ReturnType<typeof openMiraBrowserSession>> | undefined;
    try {
        const grant = await f.grant();
        const id = await reserve(f);
        await enqueueMiraBrowserCommand(f.worker, id, {
            method: "navigate",
            url: f.request.initialUrl,
        });
        const controller = new AbortController();
        const health: MiraBrowserHealth = {
            ready: false,
            heartbeatAt: 0,
            active: 0,
            unresolved: 0,
        };
        const host = runMiraBrowserHost(
            {
                client: f.client,
                configuration: f.config,
                signal: controller.signal,
                health,
            },
            {
                open: async (...args) => {
                    session = await openMiraBrowserSession(
                        args[0],
                        args[1],
                        args[2],
                        new AbortController().signal
                    );
                    try {
                        return await openMiraBrowserSession(...args);
                    } finally {
                        controller.abort();
                    }
                },
            }
        );
        await host;
        const grants = await f.api.browser.list({ runId: f.run.id });
        expect(grants[0]?.id).toBe(grant.id);
        expect(grants[0]?.state).toBe("active");
    } finally {
        await session?.close();
        await f.close();
    }
});

test("queue ownership, stale controller and consumed result fences reject cross-boundary access", async () => {
    const f = await fixture();
    let session: Awaited<ReturnType<typeof openMiraBrowserSession>> | undefined;
    try {
        const grant = await f.grant();
        const id = await reserve(f);
        await rejects(
            enqueueMiraBrowserCommand({ ...f.worker, owner: "other" }, id, {
                method: "observe",
            })
        );
        await rejects(
            enqueueMiraBrowserCommand(
                {
                    ...f.worker,
                    run: { ...f.worker.run, leaseToken: crypto.randomUUID() },
                },
                id,
                { method: "navigate", url: f.request.initialUrl }
            )
        );
        await enqueueMiraBrowserCommand(f.worker, id, {
            method: "navigate",
            url: f.request.initialUrl,
        });
        session = await openMiraBrowserSession(
            f.worker,
            grant.id,
            f.config,
            f.hostLifetime.signal
        );
        const command = await claimMiraBrowserCommand(f.client, session.claim);
        expect(command?.id).toBe(id);
        expect(await claimMiraBrowserCommand(f.client, session.claim)).toBeNull();
        await rejects(
            finishMiraBrowserCommand(
                f.client,
                { ...session.claim, leaseToken: crypto.randomUUID() },
                id,
                { url: f.request.initialUrl }
            )
        );
        expect(
            await finishMiraBrowserCommand(f.client, session.claim, id, {
                url: f.request.initialUrl,
            })
        ).toBe(true);
        expect(
            await finishMiraBrowserCommand(f.client, session.claim, id, {
                url: f.request.initialUrl,
            })
        ).toBe(false);
        await rejects(takeMiraBrowserCommand({ ...f.worker, owner: "other" }, id));
        const first = await takeMiraBrowserCommand(f.worker, id);
        const second = await takeMiraBrowserCommand(f.worker, id);
        expect(first.state).toBe("completed");
        expect(second.state).toBe("consumed");
        await f.api.browser.stop({ id: grant.id });
        await rejects(
            finalizeMiraBrowserCommand(f.worker, id, new AbortController().signal)
        );
        await abandonMiraBrowserCommand(f.worker, id);
    } finally {
        await session?.close();
        await f.close();
    }
});

test("stopping a pending grant immediately erases private URLs and expiry cleanup leaves tombstones", async () => {
    const f = await fixture();
    try {
        const grant = await f.grant();
        const id = await reserve(f, "mira_browser_navigate");
        await enqueueMiraBrowserCommand(f.worker, id, {
            method: "navigate",
            url: "https://example.test/?private=synthetic-value",
        });
        await f.api.browser.stop({ id: grant.id });
        const [row] = await f.client<
            { state: string; payload: unknown }[]
        >`SELECT state,payload FROM mira_browser_commands WHERE id=${id}`;
        expect(row).toEqual({ state: "refused", payload: null });
        expect(await cleanupMiraBrowserCommands(f.client)).toBe(0);
        await rejects(
            enqueueMiraBrowserCommand(f.worker, id, {
                method: "act",
                input: {
                    action: "click",
                    observationId: crypto.randomUUID(),
                    ref: "p1:1",
                },
            })
        );
    } finally {
        await f.close();
    }
});

test("startup rolls back grant consumption if durable process reservation cannot commit", async () => {
    const f = await fixture();
    let session: Awaited<ReturnType<typeof openMiraBrowserSession>> | undefined;
    try {
        const grant = await f.grant();
        await f.client.unsafe(
            "CREATE FUNCTION reject_browser_reservation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic insert rejection'; END $$"
        );
        await f.client.unsafe(
            "CREATE TRIGGER reject_browser_reservation BEFORE INSERT ON mira_browser_processes FOR EACH ROW EXECUTE FUNCTION reject_browser_reservation()"
        );
        await rejects(
            openMiraBrowserSession(f.worker, grant.id, f.config, f.hostLifetime.signal)
        );
        const [row] = await f.client<
            { state: string; hostToken: string | null }[]
        >`SELECT state,host_token AS "hostToken" FROM mira_browser_access WHERE id=${grant.id}`;
        expect(row).toEqual({ state: "pending", hostToken: null });
        expect(f.engine.events).toHaveLength(0);
        await f.client.unsafe(
            "DROP TRIGGER reject_browser_reservation ON mira_browser_processes"
        );
        session = await openMiraBrowserSession(
            f.worker,
            grant.id,
            f.config,
            f.hostLifetime.signal
        );
        expect(f.engine.exists).toBe(true);
    } finally {
        await session?.close();
        await f.close();
    }
});

test("cancelling a read-only browser wait records a known failure without fencing later tools", async () => {
    const f = await fixture();
    try {
        const waiting = f.invoke("mira_browser_wait", { waitSeconds: 60 });
        await until(async () => {
            const [row] = await f.client<
                { state: string }[]
            >`SELECT state FROM mira_tool_receipts WHERE tool='mira_browser_wait'`;
            return row?.state === "running";
        });
        await Bun.sleep(30);
        f.toolLifetime.abort();
        expect(text(await waiting)).toMatchObject({ ok: false, retryable: true });
        const [row] = await f.client<
            { state: string }[]
        >`SELECT state FROM mira_tool_receipts WHERE tool='mira_browser_wait'`;
        expect(row?.state).toBe("failed");
        const output = await f.tools
            .find((tool) => tool.name === "mira_browser_wait")!
            .execute({ waitSeconds: 0 }, new AbortController().signal, {
                callId: crypto.randomUUID(),
                threadId: "synthetic",
                turnId: "synthetic",
            });
        expect(text(output)).toMatchObject({ ok: true, result: { state: "waiting" } });
        expect(f.engine.events).toHaveLength(0);
    } finally {
        await f.close();
    }
});

test("replacing a stale pending grant scrubs queued private navigation atomically without a cleanup service", async () => {
    const f = await fixture();
    try {
        const previous = await f.grant();
        const id = await reserve(f, "mira_browser_navigate");
        await enqueueMiraBrowserCommand(f.worker, id, {
            method: "navigate",
            url: "https://example.test/?private=synthetic-value",
        });
        await f.client`UPDATE mira_switches SET version=version+1 WHERE owner=${f.context.owner} AND key='computer:browser'`;
        const replacement = await f.grant();
        expect(replacement.id).not.toBe(previous.id);
        const [command] = await f.client<
            { state: string; payload: unknown; result: unknown }[]
        >`SELECT state,payload,result FROM mira_browser_commands WHERE id=${id}`;
        expect(command).toEqual({ state: "refused", payload: null, result: null });
        const grants = await f.api.browser.list({ runId: f.run.id });
        expect(grants.find((grant) => grant.id === previous.id)?.state).toBe("closed");
        expect(f.engine.events).toHaveLength(0);
    } finally {
        await f.close();
    }
});

for (const character of ["界", "\u0001", '"']) {
    test(`large browser metadata is bounded before consumption for ${JSON.stringify(character)}`, async () => {
        const f = await fixture();
        try {
            await f.grant();
            f.engine.observationText = character;
            f.engine.paddedImage = character === '"';
            void f.start();
            const output = await f.invoke("mira_browser_observe", {});
            const metadata = frame(output);
            expect(metadata).toMatchObject({ complete: false });
            expect(metadata.refs.map((item) => item.ref)).toEqual(
                Array.from({ length: 300 }, (_, index) => `p1:${index + 1}`)
            );
            const content = runtimeContentItems(output);
            expect(content[0]?.type).toBe("inputText");
            if (content[0]?.type === "inputText")
                expect(Buffer.byteLength(content[0].text)).toBeLessThanOrEqual(
                    maximumToolTextBytes
                );
            const [row] = await f.client<
                { state: string; result: unknown; receipt: string }[]
            >`
                SELECT c.state,c.result,t.state AS receipt FROM mira_browser_commands c JOIN mira_tool_receipts t ON t.id=c.id`;
            expect(row).toEqual({
                state: "consumed",
                result: null,
                receipt: "succeeded",
            });
            expect(await readMiraBrowserReadiness(f.worker)).toMatchObject({
                state: "ready",
            });
            f.engine.observationText = "";
            expect(frame(await f.invoke("mira_browser_observe", {}))).toMatchObject({
                complete: true,
            });
        } finally {
            await f.close();
        }
    });
}

async function operatorCommand(
    f: Awaited<ReturnType<typeof fixture>>,
    id: string,
    operation: Parameters<typeof f.api.browser.command>[0]["operation"],
    commandId = crypto.randomUUID()
) {
    const console = await f.api.browser.console({ id });
    await f.api.browser.command({ id, epoch: console.epoch, commandId, operation });
    await until(async () => {
        const current = await f.api.browser.console({ id });
        return !current.busy;
    });
    return f.api.browser.console({ id });
}

test("private browser takeover shares the serial host without replay or Chat disclosure", async () => {
    const f = await fixture();
    try {
        const grant = await f.grant();
        void f.start();
        const observed = frame(await f.invoke("mira_browser_observe", {}));
        const first = await f.api.browser.console({ id: grant.id });
        expect(first.preview?.observationId).toBe(observed.observationId);
        expect(first.preview?.refs).toEqual([]);
        const before = f.engine.events.filter((value) => value === "observe").length;
        await f.api.browser.console({ id: grant.id });
        expect(f.engine.events.filter((value) => value === "observe")).toHaveLength(
            before
        );
        await f.api.browser.transfer({
            id: grant.id,
            epoch: first.epoch,
            controller: "human",
        });
        expect(await readMiraBrowserReadiness(f.worker)).toEqual({ state: "human" });
        expect(text(await f.invoke("mira_browser_observe", {})).ok).toBe(false);
        const view = await operatorCommand(f, grant.id, { method: "observe" });
        expect(view.controller).toBe("human");
        expect(view.preview?.refs).toHaveLength(1);
        const commandId = crypto.randomUUID();
        const operation = {
            method: "act" as const,
            input: {
                action: "type" as const,
                observationId: view.preview!.observationId,
                ref: view.preview!.refs[0]!.ref,
                text: "synthetic private value",
                replace: true,
            },
        };
        const after = await operatorCommand(f, grant.id, operation, commandId);
        expect(after.preview).toBeNull();
        await rejects(
            f.api.browser.command({
                id: grant.id,
                epoch: view.epoch,
                commandId,
                operation,
            })
        );
        expect(f.engine.events.filter((value) => value === "act")).toHaveLength(1);
        const [stored] = await f.client<
            { payload: unknown; frame: unknown }[]
        >`SELECT payload,frame FROM mira_browser_consoles WHERE access_id=${grant.id}`;
        expect(stored).toEqual({ payload: null, frame: null });
        const [logs] = await f.client<
            { found: boolean }[]
        >`SELECT EXISTS(SELECT 1 FROM mira_tool_receipts WHERE run_id=${f.run.id} AND tool LIKE '%operator%') AS found`;
        expect(logs?.found).toBe(false);
        await f.api.browser.transfer({
            id: grant.id,
            epoch: after.epoch,
            controller: "mira",
        });
        await rejects(
            f.api.browser.command({
                id: grant.id,
                epoch: after.epoch,
                commandId: crypto.randomUUID(),
                operation: { method: "observe" },
            })
        );
        expect(text(await f.invoke("mira_browser_input", operation.input)).ok).toBe(
            false
        );
        expect(frame(await f.invoke("mira_browser_observe", {})).refs).toHaveLength(1);
        await f.api.browser.stop({ id: grant.id });
        await until(() => !f.engine.exists);
        const [erased] = await f.client<
            { frame: unknown; payload: unknown }[]
        >`SELECT frame,payload FROM mira_browser_consoles WHERE access_id=${grant.id}`;
        expect(erased).toEqual({ frame: null, payload: null });
    } finally {
        await f.close();
    }
});

test("browser console requires the owner and fresh human authority for mutations", async () => {
    const f = await fixture();
    try {
        const grant = await f.grant();
        void f.start();
        await f.invoke("mira_browser_observe", {});
        const console = await f.api.browser.console({ id: grant.id });
        const transfer = {
            id: grant.id,
            epoch: console.epoch,
            controller: "human" as const,
        };
        await rejects(f.caller("other").browser.console({ id: grant.id }));
        await rejects(
            f
                .caller("operator", "operator", "automation")
                .browser.console({ id: grant.id })
        );
        await rejects(
            f.caller("operator", "operator", "human", false).browser.transfer(transfer)
        );
        await rejects(f.caller("operator", "other").browser.transfer(transfer));
        await f.api.browser.transfer(transfer);
        const current = await f.api.browser.console({ id: grant.id });
        await rejects(f.api.browser.transfer({ ...transfer, controller: "mira" }));
        await rejects(
            f.caller("operator", "operator", "human", false).browser.command({
                id: grant.id,
                epoch: current.epoch,
                commandId: crypto.randomUUID(),
                operation: { method: "observe" },
            })
        );
    } finally {
        await f.close();
    }
});

test("queued model work prevents browser takeover until its receipt settles", async () => {
    const f = await fixture();
    try {
        const grant = await f.grant();
        const session = await openMiraBrowserSession(
            f.worker,
            grant.id,
            f.config,
            f.hostLifetime.signal
        );
        try {
            const receiptId = await reserve(f);
            await enqueueMiraBrowserCommand(f.worker, receiptId, {
                method: "navigate",
                url: "https://example.test/next",
            });
            const console = await f.api.browser.console({ id: grant.id });
            const transfer = {
                id: grant.id,
                epoch: console.epoch,
                controller: "human" as const,
            };
            await rejects(f.api.browser.transfer(transfer));
            const command = await claimMiraBrowserCommand(f.client, session.claim);
            expect(command).not.toBeNull();
            await rejects(f.api.browser.transfer(transfer));
            await finishMiraBrowserCommand(f.client, session.claim, receiptId, {
                url: "https://example.test/next",
            });
            await rejects(f.api.browser.transfer(transfer));
            await takeMiraBrowserCommand(f.worker, receiptId);
            await rejects(f.api.browser.transfer(transfer));
            await finalizeMiraBrowserCommand(f.worker, receiptId, f.toolLifetime.signal);
            await f.api.browser.transfer(transfer);
            const transferred = await f.api.browser.console({ id: grant.id });
            expect(transferred.controller).toBe("human");
        } finally {
            await session.close();
        }
    } finally {
        await f.close();
    }
});

test("operator refs, view scope, request generations and limits remain enforced", async () => {
    const f = await fixture("view");
    try {
        const grant = await f.grant();
        void f.start();
        await f.invoke("mira_browser_observe", {});
        const first = await f.api.browser.console({ id: grant.id });
        await f.api.browser.transfer({
            id: grant.id,
            epoch: first.epoch,
            controller: "human",
        });
        const current = await operatorCommand(f, grant.id, { method: "observe" });
        const command = {
            id: grant.id,
            epoch: current.epoch,
            commandId: crypto.randomUUID(),
            operation: {
                method: "act" as const,
                input: {
                    action: "click" as const,
                    observationId: current.preview!.observationId,
                    ref: current.preview!.refs[0]!.ref,
                },
            },
        };
        await rejects(f.api.browser.command(command));
        await rejects(
            f.api.browser.command({
                ...command,
                operation: { method: "navigate", url: "https://unapproved.test" },
            })
        );
        const repeated = crypto.randomUUID();
        await operatorCommand(f, grant.id, { method: "observe" }, repeated);
        await rejects(
            f.api.browser.command({
                ...command,
                commandId: repeated,
                operation: { method: "observe" },
            })
        );
        await f.client`UPDATE mira_browser_consoles SET attempts=${JSON.stringify(Array.from({ length: 128 }, () => crypto.randomUUID()))}::text::jsonb WHERE access_id=${grant.id}`;
        await rejects(
            f.api.browser.command({ ...command, operation: { method: "observe" } })
        );
        expect(f.engine.events.filter((value) => value === "act")).toHaveLength(0);
    } finally {
        await f.close();
    }
});

test("expired operator observations cannot deliver input and pending input blocks return", async () => {
    const f = await fixture();
    try {
        const grant = await f.grant();
        void f.start();
        await f.invoke("mira_browser_observe", {});
        let current = await f.api.browser.console({ id: grant.id });
        await f.api.browser.transfer({
            id: grant.id,
            epoch: current.epoch,
            controller: "human",
        });
        current = await operatorCommand(f, grant.id, { method: "observe" });
        const command = {
            id: grant.id,
            epoch: current.epoch,
            commandId: crypto.randomUUID(),
            operation: {
                method: "act" as const,
                input: {
                    action: "click" as const,
                    observationId: current.preview!.observationId,
                    ref: current.preview!.refs[0]!.ref,
                },
            },
        };
        await f.client`UPDATE mira_browser_consoles SET frame_at=clock_timestamp()-interval '61 seconds' WHERE access_id=${grant.id}`;
        await rejects(f.api.browser.command(command));
        const stale = await f.api.browser.console({ id: grant.id });
        expect(stale.preview).toBeNull();
        current = await operatorCommand(f, grant.id, { method: "observe" });
        f.engine.holdInput = true;
        await f.api.browser.command({
            ...command,
            operation: {
                ...command.operation,
                input: {
                    ...command.operation.input,
                    observationId: current.preview!.observationId,
                },
            },
        });
        await until(() => f.engine.events.includes("act"));
        await rejects(
            f.api.browser.transfer({
                id: grant.id,
                epoch: current.epoch,
                controller: "mira",
            })
        );
        await f.api.browser.stop({ id: grant.id });
        await until(() => !f.engine.exists);
        await rejects(f.api.browser.console({ id: grant.id }));
        const [erased] = await f.client<
            { payload: unknown; frame: unknown; state: string }[]
        >`SELECT payload,frame,state FROM mira_browser_consoles WHERE access_id=${grant.id}`;
        expect(erased).toEqual({ payload: null, frame: null, state: "idle" });
    } finally {
        await f.close();
    }
});

test("independent cleanup erases old previews and expires operator work without a host loop", async () => {
    const f = await fixture();
    try {
        const grant = await f.grant();
        const session = await openMiraBrowserSession(
            f.worker,
            grant.id,
            f.config,
            f.hostLifetime.signal
        );
        try {
            const receiptId = await reserve(f, "mira_browser_observe");
            await enqueueMiraBrowserCommand(f.worker, receiptId, { method: "observe" });
            await claimMiraBrowserCommand(f.client, session.claim);
            await finishMiraBrowserCommand(
                f.client,
                session.claim,
                receiptId,
                await session.observe(f.toolLifetime.signal)
            );
            await takeMiraBrowserCommand(f.worker, receiptId);
            await finalizeMiraBrowserCommand(f.worker, receiptId, f.toolLifetime.signal);
            await f.client`UPDATE mira_browser_consoles SET frame_at=clock_timestamp()-interval '61 seconds' WHERE access_id=${grant.id}`;
            await cleanupMiraBrowserCommands(f.client);
            const current = await f.api.browser.console({ id: grant.id });
            expect(current.preview).toBeNull();
            await f.api.browser.transfer({
                id: grant.id,
                epoch: current.epoch,
                controller: "human",
            });
            const human = await f.api.browser.console({ id: grant.id });
            await f.api.browser.command({
                id: grant.id,
                epoch: human.epoch,
                commandId: crypto.randomUUID(),
                operation: {
                    method: "navigate",
                    url: "https://example.test/private-synthetic",
                },
            });
            await f.client`UPDATE mira_browser_consoles SET expires_at=clock_timestamp()-interval '1 second' WHERE access_id=${grant.id}`;
            await cleanupMiraBrowserCommands(f.client);
            await rejects(f.api.browser.console({ id: grant.id }));
            const [row] = await f.client<
                { state: string; payload: unknown }[]
            >`SELECT state,payload FROM mira_browser_consoles WHERE access_id=${grant.id}`;
            expect(row).toEqual({ state: "idle", payload: null });
            expect(f.engine.events.filter((value) => value === "navigate")).toHaveLength(
                0
            );
        } finally {
            await session.close();
        }
    } finally {
        await f.close();
    }
});

test("operator-confirmed conversation attachment crosses the private host queue once", async () => {
    const f = await fixture();
    const directory = await mkdtemp(path.join(os.tmpdir(), "mira-browser-upload-"));
    try {
        const bytes = new Uint8Array(100_003).fill(97);
        await saveMiraFile(f.context, directory, {
            id: crypto.randomUUID(),
            name: "unrelated.txt",
            bytes,
        });
        await saveMiraFile(
            { ...f.context, owner: "other", actor: "human:other" },
            directory,
            { id: crypto.randomUUID(), name: "other-owner.txt", bytes }
        );
        const file = await saveMiraFile(f.context, directory, {
            id: crypto.randomUUID(),
            name: "fixture.txt",
            bytes,
        });
        await f.client`UPDATE mira_messages SET attachment_ids=${JSON.stringify([file.id])}::text::jsonb WHERE id=${f.run.userMessageId}`;
        const grant = await f.grant();
        void f.start(directory);
        await f.invoke("mira_browser_observe", {});
        const initial = await f.api.browser.console({ id: grant.id });
        await rejects(f.api.browser.uploads({ id: grant.id }));
        await f.api.browser.transfer({
            id: grant.id,
            epoch: initial.epoch,
            controller: "human",
        });
        f.engine.uploadInput = true;
        const view = await operatorCommand(f, grant.id, { method: "observe" });
        const choices = await f.api.browser.uploads({ id: grant.id });
        expect(choices).toHaveLength(1);
        const operation = {
            method: "upload" as const,
            origin: f.request.origins[0]!,
            input: {
                observationId: view.preview!.observationId,
                ref: view.preview!.refs[0]!.ref,
            },
            file: choices[0]!,
        };
        await rejects(f.caller("other").browser.uploads({ id: grant.id }));
        await rejects(
            f
                .caller("operator", "operator", "automation")
                .browser.uploads({ id: grant.id })
        );
        for (const invalid of [
            { ...operation, origin: "https://other.test" },
            { ...operation, file: { ...operation.file, sha256: "0".repeat(64) } },
            { ...operation, file: { ...operation.file, id: crypto.randomUUID() } },
            { ...operation, input: { ...operation.input, ref: "p1:999" } },
            {
                ...operation,
                input: { ...operation.input, observationId: crypto.randomUUID() },
            },
        ])
            await rejects(
                f.api.browser.command({
                    id: grant.id,
                    epoch: view.epoch,
                    commandId: crypto.randomUUID(),
                    operation: invalid,
                })
            );
        await rejects(
            f.caller("operator", "operator", "human", false).browser.command({
                id: grant.id,
                epoch: view.epoch,
                commandId: crypto.randomUUID(),
                operation,
            })
        );
        await operatorCommand(f, grant.id, operation);
        expect(f.engine.uploads).toEqual([
            { name: file.name, size: bytes.length, sha256: operation.file.sha256, bytes },
        ]);
        await rejects(
            f.api.browser.command({
                id: grant.id,
                epoch: view.epoch,
                commandId: crypto.randomUUID(),
                operation,
            })
        );
        const [stored] = await f.client<
            { payload: unknown; frame: unknown; state: string }[]
        >`SELECT payload,frame,state FROM mira_browser_consoles WHERE access_id=${grant.id}`;
        expect(stored).toEqual({ payload: null, frame: null, state: "idle" });
        expect(
            text(
                await f.invoke("mira_browser_input", {
                    action: "upload",
                    ...operation.input,
                })
            ).ok
        ).toBe(false);
    } finally {
        await f.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("claimed upload rechecks immutable confirmation before any file leaves the host", async () => {
    const f = await fixture();
    const directory = await mkdtemp(path.join(os.tmpdir(), "mira-browser-claim-"));
    let session: Awaited<ReturnType<typeof openMiraBrowserSession>> | undefined;
    try {
        const file = await saveMiraFile(f.context, directory, {
            id: crypto.randomUUID(),
            name: "fixture.txt",
            bytes: new TextEncoder().encode("approved"),
        });
        await f.client`UPDATE mira_messages SET attachment_ids=${JSON.stringify([file.id])}::text::jsonb WHERE id=${f.run.userMessageId}`;
        const grant = await f.grant();
        session = await openMiraBrowserSession(
            f.worker,
            grant.id,
            f.config,
            f.hostLifetime.signal
        );
        const initial = await f.api.browser.console({ id: grant.id });
        await f.api.browser.transfer({
            id: grant.id,
            epoch: initial.epoch,
            controller: "human",
        });
        f.engine.uploadInput = true;
        const image = await session.observe(f.toolLifetime.signal, true);
        await f.client.begin(async (query) => {
            await lockBrowserOwner(query, f.context.owner);
            await saveBrowserPreview(query, grant.id, image);
        });
        const current = await f.api.browser.console({ id: grant.id });
        const choices = await f.api.browser.uploads({ id: grant.id });
        const command = {
            id: grant.id,
            epoch: current.epoch,
            commandId: crypto.randomUUID(),
            operation: {
                method: "upload" as const,
                origin: f.request.origins[0]!,
                input: { observationId: image.observationId, ref: image.refs[0]!.ref },
                file: choices[0]!,
            },
        };
        await f.client`UPDATE mira_browser_consoles SET frame_at=clock_timestamp()-interval '61 seconds' WHERE access_id=${grant.id}`;
        await rejects(f.api.browser.command(command));
        await f.client`UPDATE mira_browser_consoles SET frame_at=clock_timestamp() WHERE access_id=${grant.id}`;
        await f.api.browser.command(command);
        await f.client`UPDATE mira_attachments SET sha256=${"0".repeat(64)} WHERE id=${file.id}`;
        await rejects(claimBrowserHumanCommand(f.client, session.claim));
        expect(f.engine.uploads).toEqual([]);
    } finally {
        await session?.close();
        await f.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("file selection remains unavailable for view and multi-website browser grants", async () => {
    for (const mode of ["view", "control"] as const) {
        const f = await fixture(mode);
        try {
            const grant = await f.api.browser.request({
                ...f.request,
                mode,
                origins:
                    mode === "control"
                        ? [...f.request.origins, "https://second.test"]
                        : f.request.origins,
            });
            void f.start();
            await f.invoke("mira_browser_observe", {});
            const state = await f.api.browser.console({ id: grant.id });
            await f.api.browser.transfer({
                id: grant.id,
                epoch: state.epoch,
                controller: "human",
            });
            await rejects(f.api.browser.uploads({ id: grant.id }));
        } finally {
            await f.close();
        }
    }
});
