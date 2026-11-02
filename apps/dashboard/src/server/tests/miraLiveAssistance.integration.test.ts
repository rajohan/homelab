import { expect, spyOn, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { miraDefaultChatSettings } from "@homelab/contracts/mira";
import { capabilities } from "@homelab/contracts/operations";
import {
    claimChatSteering,
    acknowledgeChatSteering,
} from "@homelab/mira/data/chatSteering";
import {
    acceptMiraComputerAccess,
    stopMiraComputerAccessLocally,
} from "@homelab/mira/data/computerAccess";
import { connectMiraComputer, enrollMiraComputer } from "@homelab/mira/data/computers";
import { readLiveAssistanceGuidance } from "@homelab/mira/data/liveAssistance";
import { claimMiraRun } from "@homelab/mira/data/queue";

import { version } from "../../../../../package.json";
import { executeMiraTurn } from "../../../../mira/src/server/executor/turn";
import { appRouter } from "../api/router";
import { operationFixture } from "../testing/operations";

async function fixture() {
    const f = await operationFixture();
    const principal = { kind: "human" as const, id: "operator", capabilities };
    const api = appRouter.createCaller({
        operations: f,
        principal,
        verifyHuman: () => Promise.resolve(principal),
    }).mira;
    const chat = await api.conversations.create({ title: "Live assistance fixture" });
    await api.conversations.settings({
        id: chat.id,
        version: 1,
        settings: { ...miraDefaultChatSettings, liveAssistanceMinutes: 60 },
    });
    await api.conversations.send({
        conversationId: chat.id,
        requestId: crypto.randomUUID(),
        text: "Coach this synthetic activity.",
    });
    return { ...f, api, chat };
}

test("live assistance leaves the reserved worker available and freezes its explicit duration", async () => {
    const f = await fixture();
    try {
        expect(
            await claimMiraRun(f.client, crypto.randomUUID(), "foreground")
        ).toBeNull();
        const quick = await f.api.conversations.create({ title: "Quick question" });
        await f.api.conversations.send({
            conversationId: quick.id,
            requestId: crypto.randomUUID(),
            text: "What is the status?",
        });
        const short = await claimMiraRun(f.client, crypto.randomUUID(), "foreground");
        expect(short?.conversationId).toBe(quick.id);
        expect(short?.budgetSeconds).toBe(300);
        const live = await claimMiraRun(f.client, crypto.randomUUID(), "general");
        expect(live?.conversationId).toBe(f.chat.id);
        expect(live?.budgetSeconds).toBe(3600);
    } finally {
        await f.close();
    }
});

test("continuations retain acknowledged guidance and refuse foreign leases and uncertain actions", async () => {
    const f = await fixture();
    try {
        const run = (await claimMiraRun(f.client, crypto.randomUUID(), "general"))!;
        await f.api.conversations.send({
            conversationId: f.chat.id,
            requestId: crypto.randomUUID(),
            text: "Observe only. Do not click.",
        });
        const before = await readLiveAssistanceGuidance(f.client, run);
        expect(before.guidance).toEqual([]);
        const guidance = (await claimChatSteering(f.client, run))!;
        expect(await acknowledgeChatSteering(f.client, run, guidance.id, true)).toBe(
            true
        );
        expect(await readLiveAssistanceGuidance(f.client, run)).toEqual({
            guidance: ["Observe only. Do not click."],
            yieldForAttachments: false,
            uncertain: false,
        });
        await rejects(
            readLiveAssistanceGuidance(f.client, { ...run, owner: "another-owner" }),
            /no longer active/
        );
        await rejects(
            readLiveAssistanceGuidance(f.client, {
                ...run,
                leaseToken: crypto.randomUUID(),
            }),
            /no longer active/
        );
        await f.client`INSERT INTO mira_tool_receipts(id,run_id,call_id,tool,input_hash,state) VALUES(${crypto.randomUUID()},${run.id},'uncertain-input','mira_computer_input','fixture','unknown')`;
        const after = await readLiveAssistanceGuidance(f.client, run);
        expect(after.uncertain).toBe(true);
    } finally {
        await f.close();
    }
});

async function executorFixture() {
    const f = await fixture();
    const directory = await mkdtemp(path.join(tmpdir(), "mira-live-assistance-"));
    const stop = new AbortController();
    const run = (await claimMiraRun(f.client, crypto.randomUUID(), "general"))!;
    const pair = await f.api.computers.pair({ label: "Synthetic live PC" });
    const device = await enrollMiraComputer(f.client, pair.token, {
        installationId: crypto.randomUUID(),
        platform: "win32",
        version,
    });
    const connection = await connectMiraComputer(f.client, device.credential, {
        version,
    });
    const grant = await f.api.computers.access.request({
        computerId: pair.id,
        computerVersion: 2,
        runId: run.id,
        mode: "view",
        keepOpen: true,
    });
    await acceptMiraComputerAccess(f.client, device.credential, {
        id: grant.id,
        connectionId: connection.connectionId,
        targetId: crypto.randomUUID(),
    });
    const command = path.join(directory, "synthetic-codex");
    const home = path.join(directory, "home"),
        workspace = path.join(directory, "workspace");
    await mkdir(home);
    await mkdir(workspace);
    const child = fileURLToPath(
        new URL("../../../../mira/src/server/testing/runtimeChild.ts", import.meta.url)
    );
    await writeFile(
        command,
        `#!/usr/bin/env bun\nprocess.argv=[process.argv[0],${JSON.stringify(child)},"resume-missing",${JSON.stringify(home)}];\nawait import(${JSON.stringify(child)});\n`
    );
    await chmod(command, 0o700);
    let execution: Promise<void> | undefined;
    const replies = async () => {
        const chat = await f.api.conversations.read({ id: f.chat.id });
        return {
            chat,
            messages: chat.messages.filter(
                (message) => message.role === "assistant" && message.content
            ),
        };
    };
    return {
        ...f,
        run,
        device,
        grant,
        pair,
        stop,
        replies,
        start: (synthetic = false) => {
            execution = executeMiraTurn(
                f.client,
                {
                    command,
                    codexHome: home,
                    workspace,
                    model: synthetic ? "syn:large:vision" : "synthetic",
                },
                run,
                stop.signal,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                synthetic
                    ? { owner: "operator", apiKey: "fixture-live-subscription-key" }
                    : undefined
            );
            return execution;
        },
        waitForReplies: async (count: number) => {
            for (let attempt = 0; attempt < 220; attempt++) {
                const current = await replies();
                if (
                    current.messages.length >= count ||
                    current.chat.run?.state !== "running"
                )
                    return current;
                await delay(100);
            }
            throw new Error("Fixture replies did not arrive.");
        },
        close: async () => {
            stop.abort();
            await Promise.allSettled([execution]);
            await f.close();
            await rm(directory, { recursive: true, force: true });
        },
    };
}

test("the executor continues after a reply, delivers idle guidance in a new bubble and honors Stop", async () => {
    const f = await executorFixture();
    try {
        const execution = f.start();
        const first = await f.waitForReplies(1);
        expect(first.chat.run?.state).toBe("running");
        expect(first.messages).toHaveLength(1);
        await f.api.conversations.send({
            conversationId: f.chat.id,
            requestId: crypto.randomUUID(),
            text: "Focus on the map now.",
        });
        const continued = await f.waitForReplies(2);
        expect(continued.chat.run?.state).toBe("running");
        expect(continued.messages).toHaveLength(2);
        expect(continued.messages[1]?.content).toContain("Focus on the map now.");
        expect(continued.messages[0]?.id).not.toBe(continued.messages[1]?.id);
        await f.api.runs.cancel({ id: f.run.id });
        await execution;
        const stopped = await f.replies();
        expect(stopped.chat.run?.state).toBe("interrupted");
        expect(stopped.messages).toHaveLength(2);
    } finally {
        await f.close();
    }
}, 35_000);

test.each([
    "local stop",
    "disconnect",
    "uncertain action",
    "deadline",
    "shutdown",
] as const)(
    "the executor never starts another observation after %s",
    async (reason) => {
        const f = await executorFixture();
        try {
            if (reason === "deadline") f.run.deadlineAt = Date.now() + 5000;
            const execution = f.start();
            const first = await f.waitForReplies(1);
            expect(first.messages).toHaveLength(1);
            if (reason === "local stop")
                await stopMiraComputerAccessLocally(f.client, f.device.credential, {
                    id: f.grant.id,
                });
            if (reason === "disconnect")
                await f.client`UPDATE mira_computers SET connection_expires_at=clock_timestamp()-interval '1 second' WHERE id=${f.pair.id}`;
            if (reason === "uncertain action")
                await f.client`INSERT INTO mira_tool_receipts(id,run_id,call_id,tool,input_hash,state) VALUES(${crypto.randomUUID()},${f.run.id},'uncertain-input','mira_computer_input','fixture','unknown')`;
            if (reason === "shutdown") f.stop.abort();
            await execution;
            const ended = await f.replies();
            expect(ended.messages).toHaveLength(1);
            expect(ended.chat.run?.state).toBe(
                reason === "uncertain action" ? "needs_attention" : "completed"
            );
        } finally {
            await f.close();
        }
    },
    25_000
);

test("Synthetic continuations preserve accepted guidance and can finish without another turn", async () => {
    const f = await executorFixture();
    const bodies: string[] = [];
    const nativeFetch = fetch;
    const model = {
        id: "syn:large:vision",
        always_on: true,
        alias_of: "Fixture vision",
        input_modalities: ["text", "image"],
        output_modalities: ["text"],
        supported_features: ["tools", "reasoning"],
        reasoning_parameters: { efforts: ["low"] },
    };
    const provider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
            const url = new URL(request.url);
            if (url.pathname.endsWith("/models")) return Response.json({ data: [model] });
            if (url.pathname.endsWith("/quotas"))
                return Response.json({ subscription: { limit: 100, requests: 0 } });
            bodies.push(await request.text());
            const finish = bodies.length === 3;
            const delta = finish
                ? {
                      tool_calls: [
                          {
                              index: 0,
                              id: "finish-live",
                              type: "function",
                              function: {
                                  name: "mira_tool_call",
                                  arguments: JSON.stringify({
                                      name: "mira_live_assistance_finish",
                                      arguments: {},
                                  }),
                              },
                          },
                      ],
                  }
                : { content: `Advice ${bodies.length}` };
            return new Response(
                `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
                { headers: { "content-type": "text/event-stream" } }
            );
        },
    });
    const request = spyOn(globalThis, "fetch").mockImplementation(
        Object.assign(
            (input: string | URL | Request, init?: RequestInit) => {
                const url = new URL(input instanceof Request ? input.url : input);
                if (url.origin !== "https://api.synthetic.new")
                    throw new Error("Unexpected external request in fixture.");
                return nativeFetch(
                    `http://127.0.0.1:${provider.port}${url.pathname}`,
                    init
                );
            },
            { preconnect: nativeFetch.preconnect }
        )
    );
    try {
        const execution = f.start(true);
        const first = await f.waitForReplies(1);
        expect(first.chat.run?.state).toBe("running");
        await f.api.conversations.send({
            conversationId: f.chat.id,
            requestId: crypto.randomUUID(),
            text: "Never click. Only comment on the map.",
        });
        const second = await f.waitForReplies(2);
        expect(second.messages).toHaveLength(2);
        await execution;
        const ended = await f.replies();
        expect(ended.chat.run?.state).toBe("completed");
        expect(ended.messages).toHaveLength(3);
        expect(bodies).toHaveLength(4);
        expect(bodies[1]).toContain("Never click. Only comment on the map.");
        expect(bodies[2]).toContain("Never click. Only comment on the map.");
        expect(bodies[2]).toContain("Coach this synthetic activity.");
        expect(bodies[2]).toContain("Advice 2");
    } finally {
        await f.close();
        request.mockRestore();
        await provider.stop(true);
    }
}, 45_000);
