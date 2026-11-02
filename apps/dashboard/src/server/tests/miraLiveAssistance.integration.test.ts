import { expect, spyOn, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { miraDefaultChatSettings, miraModelSchema } from "@homelab/contracts/mira";
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
import { saveMiraFile } from "@homelab/mira/data/files";
import { readLiveAssistanceGuidance } from "@homelab/mira/data/liveAssistance";
import { claimMiraRun, finishMiraRun } from "@homelab/mira/data/queue";
import * as v from "valibot";

import { version } from "../../../../../package.json";
import { executeMiraTurn } from "../../../../mira/src/server/executor/turn";
import { CodexRuntime } from "../../../../mira/src/server/runtime/codexRuntime";
import { appRouter } from "../api/router";
import { operationFixture } from "../testing/operations";

async function fixture(filesDirectory?: string) {
    const f = await operationFixture();
    const principal = { kind: "human" as const, id: "operator", capabilities };
    const api = appRouter.createCaller({
        operations: f,
        principal,
        verifyHuman: () => Promise.resolve(principal),
    }).mira;
    const models = [v.parse(miraModelSchema, { model: "synthetic", isDefault: true })];
    await f.client`INSERT INTO mira_runtime_status(id,worker_id,version,model,ready,heartbeat_at,models) VALUES(1,${crypto.randomUUID()},'fixture','synthetic',true,now(),${JSON.stringify(models)}::text::jsonb)`;
    const chat = await api.conversations.create({ title: "Live assistance fixture" });
    await api.conversations.settings({
        id: chat.id,
        version: 1,
        settings: { ...miraDefaultChatSettings, liveAssistanceMinutes: 60 },
    });
    const attachment = filesDirectory
        ? await saveMiraFile(
              { client: f.client, owner: "operator", actor: "human:operator" },
              filesDirectory,
              {
                  id: crypto.randomUUID(),
                  name: "map.txt",
                  bytes: new TextEncoder().encode("Fixture map legend"),
              }
          )
        : null;
    await api.conversations.send({
        conversationId: chat.id,
        requestId: crypto.randomUUID(),
        text: "Coach this synthetic activity.",
        attachmentIds: attachment ? [attachment.id] : [],
    });
    return { ...f, api, chat };
}

test("live settings reject explicit and automatic text-only models before queuing work", async () => {
    const f = await fixture();
    try {
        const models = [
            v.parse(miraModelSchema, {
                model: "text-only",
                isDefault: true,
                inputModalities: ["text"],
            }),
        ];
        await f.client`UPDATE mira_runtime_status SET models=${JSON.stringify(models)}::text::jsonb,model='text-only' WHERE id=1`;
        const chat = await f.api.conversations.create({ title: "Settings validation" });
        for (const model of [null, "text-only"]) {
            await rejects(
                f.api.conversations.settings({
                    id: chat.id,
                    version: 1,
                    settings: {
                        ...miraDefaultChatSettings,
                        model,
                        liveAssistanceMinutes: 30,
                    },
                }),
                /requires a model that supports images/
            );
        }
        await f.client`UPDATE mira_runtime_status SET heartbeat_at=now()-interval '1 minute' WHERE id=1`;
        await rejects(
            f.api.conversations.settings({
                id: chat.id,
                version: 1,
                settings: { ...miraDefaultChatSettings, liveAssistanceMinutes: 30 },
            }),
            /Reconnect Mira/
        );
        await f.api.conversations.settings({
            id: chat.id,
            version: 1,
            settings: { ...miraDefaultChatSettings, liveAssistanceMinutes: 0 },
        });
        const saved = await f.api.conversations.read({ id: chat.id });
        expect(saved.run).toBeNull();
        expect(saved.conversation.settings.liveAssistanceMinutes).toBe(0);
        const run = (await claimMiraRun(f.client, crypto.randomUUID(), "general"))!;
        await finishMiraRun(f.client, run, {
            state: "completed",
            text: "Done.",
            message: null,
        });
        const enabled = await f.api.conversations.read({ id: f.chat.id });
        await f.api.conversations.settings({
            id: f.chat.id,
            version: enabled.conversation.version,
            settings: {
                ...enabled.conversation.settings,
                useMemory: false,
                useHistory: false,
            },
        });
        const updated = await f.api.conversations.read({ id: f.chat.id });
        expect(updated.conversation.settings.liveAssistanceMinutes).toBe(60);
        expect(updated.conversation.settings.useMemory).toBe(false);
        await rejects(
            f.api.conversations.settings({
                id: f.chat.id,
                version: updated.conversation.version,
                settings: {
                    ...updated.conversation.settings,
                    liveAssistanceMinutes: 120,
                },
            }),
            /Reconnect Mira/
        );
    } finally {
        await f.close();
    }
});

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
        await finishMiraRun(f.client, short!, {
            state: "completed",
            text: "Synthetic quick reply.",
            message: null,
        });
        const automation = await f.api.automations.create({
            title: "Manual automation with shared settings",
            prompt: "Check synthetic status.",
            kind: "custom",
            delivery: "silent",
            schedule: { kind: "daily", time: "09:30" },
            budgetSeconds: 60,
            settings: { ...miraDefaultChatSettings, liveAssistanceMinutes: 60 },
        });
        const manual = await f.api.automations.run({
            id: automation.id,
            requestId: crypto.randomUUID(),
        });
        const claim = await claimMiraRun(f.client, crypto.randomUUID(), "foreground");
        expect(claim?.id).toBe(manual.id);
        expect(claim?.automationId).toBe(automation.id);
        expect(claim?.budgetSeconds).toBe(60);
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

async function executorFixture(mode = "resume-missing") {
    const directory = await mkdtemp(path.join(tmpdir(), "mira-live-assistance-"));
    const filesDirectory = path.join(directory, "files");
    const f = await fixture(filesDirectory);
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
        `#!/usr/bin/env bun\nprocess.argv=[process.argv[0],${JSON.stringify(child)},${JSON.stringify(mode)},${JSON.stringify(home)}];\nawait import(${JSON.stringify(child)});\n`
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
                filesDirectory,
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
                if (current.messages.length >= count) return current;
                // Messages are read before run status. Refresh after terminal visibility
                // rather than returning a transcript fetched just before finalization.
                if (current.chat.run?.state !== "running") return replies();
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
    const timeouts: (number | undefined)[] = [];
    // oxlint-disable-next-line typescript/unbound-method -- The spy calls the original with the real runtime receiver.
    const turn = CodexRuntime.prototype.turn;
    const observed = spyOn(CodexRuntime.prototype, "turn").mockImplementation(function (
        this: CodexRuntime,
        thread,
        text,
        options
    ) {
        timeouts.push(options?.timeoutMs);
        return turn.call(this, thread, text, options);
    });
    try {
        const execution = f.start();
        const first = await f.waitForReplies(1);
        expect(first.chat.run?.state).toBe("running");
        expect(first.messages).toHaveLength(1);
        expect(first.messages[0]?.content).toContain("Fixture map legend");
        await f.api.conversations.send({
            conversationId: f.chat.id,
            requestId: crypto.randomUUID(),
            text: "Focus on the map now.",
        });
        const continued = await f.waitForReplies(2);
        expect(continued.chat.run?.state).toBe("running");
        expect(continued.messages).toHaveLength(2);
        expect(continued.messages[1]?.content).toContain("Focus on the map now.");
        expect(continued.messages[1]?.content).not.toContain("Fixture map legend");
        expect(continued.messages[0]?.id).not.toBe(continued.messages[1]?.id);
        await f.api.runs.cancel({ id: f.run.id });
        await execution;
        const stopped = await f.replies();
        expect(stopped.chat.run?.state).toBe("interrupted");
        expect(stopped.messages).toHaveLength(2);
        expect(stopped.messages.map((message) => message.state)).toEqual([
            "completed",
            "completed",
        ]);
        expect(timeouts).toEqual([300_000, 300_000]);
    } finally {
        await f.close();
        observed.mockRestore();
    }
}, 35_000);

test("Stop between readiness and provider acknowledgement rejects the continuation immediately", async () => {
    const f = await executorFixture();
    // oxlint-disable-next-line typescript/unbound-method -- The spy calls the original with the real runtime receiver.
    const turn = CodexRuntime.prototype.turn;
    let starts = 0;
    let rejected = false;
    const observed = spyOn(CodexRuntime.prototype, "turn").mockImplementation(function (
        this: CodexRuntime,
        thread,
        text,
        options
    ) {
        starts++;
        return turn.call(this, thread, text, {
            ...options,
            onStarted: async (id) => {
                if (starts === 2) await f.api.runs.cancel({ id: f.run.id });
                try {
                    await options?.onStarted?.(id);
                } catch (error) {
                    rejected = true;
                    throw error;
                }
            },
        });
    });
    try {
        await f.start();
        expect(starts).toBe(2);
        expect(rejected).toBe(true);
        const ended = await f.replies();
        expect(ended.chat.run?.state).toBe("interrupted");
        const [run] = await f.client<
            { provider_turn: string | null }[]
        >`SELECT provider_turn FROM mira_runs WHERE id=${f.run.id}`;
        expect(run?.provider_turn).toBe("turn-1");
    } finally {
        await f.close();
        observed.mockRestore();
    }
}, 30_000);

test("live reply limits include continuation separators and preserve a terminal record", async () => {
    const f = await executorFixture("message-live-limit");
    try {
        await f.start();
        const ended = await f.replies();
        expect(ended.chat.run?.state).toBe("needs_attention");
        expect(ended.chat.run?.message).toContain("reply limit");
        expect(ended.messages).toHaveLength(1);
        expect(ended.messages[0]?.content).toBe("x".repeat(255_999));
        expect(ended.messages[0]?.state).toBe("completed");
        const [run] = await f.client<
            { finished_at: Date | null }[]
        >`SELECT finished_at FROM mira_runs WHERE id=${f.run.id}`;
        expect(run!.finished_at).not.toBeNull();
    } finally {
        await f.close();
    }
}, 30_000);

test("a failed continuation keeps the earlier completed reply and its own failed state", async () => {
    const f = await executorFixture("live-partial-failure");
    try {
        await f.start();
        const ended = await f.replies();
        expect(ended.chat.run?.state).toBe("failed");
        expect(ended.messages.map((message) => message.state)).toEqual([
            "completed",
            "failed",
        ]);
    } finally {
        await f.close();
    }
}, 30_000);

test("accepted steering supersedes a finish request and a later finish still ends the session", async () => {
    const f = await executorFixture("live-finish-steer");
    try {
        const execution = f.start();
        const first = await f.waitForReplies(1);
        expect(first.chat.run?.state).toBe("running");
        expect(first.messages[0]?.content).toContain("will finish after this reply");
        await f.api.conversations.send({
            conversationId: f.chat.id,
            requestId: crypto.randomUUID(),
            text: "Keep observing; the activity is not finished.",
        });
        await execution;
        const ended = await f.replies();
        expect(ended.chat.run?.state).toBe("completed");
        expect(
            ended.messages.some((message) => message.content.includes("Keep observing"))
        ).toBe(true);
        expect(
            ended.messages.filter((message) =>
                message.content.includes("will finish after this reply")
            )
        ).toHaveLength(2);
        const [run] = await f.client<
            { provider_turn: string | null }[]
        >`SELECT provider_turn FROM mira_runs WHERE id=${f.run.id}`;
        expect(run!.provider_turn).toBe("turn-2");
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
            expect(first.messages, JSON.stringify(first.chat.run)).toHaveLength(1);
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
        for (const body of bodies) expect(body).toContain("Fixture map legend");
    } finally {
        await f.close();
        request.mockRestore();
        await provider.stop(true);
    }
}, 45_000);
