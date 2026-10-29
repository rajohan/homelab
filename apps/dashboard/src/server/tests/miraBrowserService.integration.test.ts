import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";

import {
    abandonMiraBrowserCommand,
    claimMiraBrowserCommand,
    cleanupMiraBrowserCommands,
    enqueueMiraBrowserCommand,
    finalizeMiraBrowserCommand,
    finishMiraBrowserCommand,
    takeMiraBrowserCommand,
} from "@homelab/mira/data/browserCommands";
import { openMiraBrowserSession } from "@homelab/mira/data/browserHost";
import { readMiraBrowserReadiness } from "@homelab/mira/data/browserReadiness";
import {
    runMiraBrowserHost,
    type MiraBrowserHealth,
} from "@homelab/mira/data/browserService";

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
        start: () => {
            host = runMiraBrowserHost({
                client: f.client,
                configuration: f.config,
                signal: hostLifetime.signal,
                health,
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

test("stopping a pending grant immediately erases text and expiry cleanup leaves tombstones", async () => {
    const f = await fixture();
    try {
        const grant = await f.grant();
        const id = await reserve(f, "mira_browser_input");
        await enqueueMiraBrowserCommand(f.worker, id, {
            method: "act",
            input: {
                action: "type",
                observationId: crypto.randomUUID(),
                ref: "p1:1",
                text: "Synthetic private text",
                replace: true,
            },
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

test("replacing a stale pending grant scrubs queued private input atomically without a cleanup service", async () => {
    const f = await fixture();
    try {
        const previous = await f.grant();
        const id = await reserve(f, "mira_browser_input");
        await enqueueMiraBrowserCommand(f.worker, id, {
            method: "act",
            input: {
                action: "type",
                observationId: crypto.randomUUID(),
                ref: "p1:1",
                text: "Synthetic private text",
                replace: true,
            },
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
