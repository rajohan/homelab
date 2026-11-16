import { expect, spyOn, test } from "bun:test";
import { rejects } from "node:assert/strict";

import { capabilities } from "@homelab/contracts/operations";
import { MiraFailure } from "@homelab/mira/data/context";
import { decideMiraProposal, listMiraProposals } from "@homelab/mira/data/proposals";
import { claimMiraRun, finishMiraRun } from "@homelab/mira/data/queue";
import { createMiraOperationsTools } from "@homelab/mira/operations/tools";

import { createMiraTools } from "../../../../mira/src/server/executor/tools";
import * as hostSsh from "../../../../mira/src/server/operations/ssh";
import { appRouter } from "../api/router";
import { permissionRun } from "../testing/miraPermissions";
import { operationFixture } from "../testing/operations";

async function fixture(mode: "ask" | "approve_for_me" | "full_access") {
    const database = await operationFixture();
    const principal = { kind: "human" as const, id: "operator", capabilities };
    const api = appRouter.createCaller({ operations: database, principal }).mira;
    const approved = appRouter.createCaller({
        operations: database,
        principal,
        verifyHuman: () => Promise.resolve(principal),
    }).mira;
    const current = await permissionRun(database.client, api, mode);
    const configuration = {
        owner: "operator",
        targets: [
            {
                id: "main",
                label: "Main",
                host: "127.0.0.1",
                user: "fixture",
                port: 22,
                identityFile: "/synthetic/key",
                knownHostsFile: "/synthetic/known_hosts",
            },
        ],
    };
    const calls: string[] = [];
    const tools = createMiraOperationsTools(
        database.client,
        current.run,
        configuration,
        (_target, command) => {
            calls.push(command.command);
            return Promise.resolve({
                exitCode: 0,
                stdout: "synthetic",
                stderr: "",
                truncated: false,
                trust: "untrusted_host_output",
            });
        }
    );
    const receiptId = crypto.randomUUID();
    await database.client`INSERT INTO mira_tool_receipts(id,run_id,call_id,tool,input_hash,state) VALUES(${receiptId},${current.run.id},${receiptId},'mira_homelab_command',${"0".repeat(64)},'running')`;
    const invoke = (signal = new AbortController().signal, id = receiptId) =>
        tools
            .find((tool) => tool.name === "mira_homelab_command")!
            .action(
                {
                    target: "main",
                    command: "printf synthetic",
                    reason: "Test exact approval",
                },
                signal,
                { ...current.context, receiptId: id }
            );
    return {
        ...database,
        ...current,
        api,
        approved,
        calls,
        invoke,
        receiptId,
        configuration,
        resume: async (id: string = receiptId, run = current.run) => {
            const resumed = crypto.randomUUID();
            await database.client`INSERT INTO mira_tool_receipts(id,run_id,call_id,tool,input_hash,state) VALUES(${resumed},${run.id},${resumed},'mira_homelab_resume',${"0".repeat(64)},'running')`;
            return createMiraOperationsTools(
                database.client,
                run,
                configuration,
                (_target, command) => {
                    calls.push(command.command);
                    return Promise.resolve({
                        exitCode: 0,
                        stdout: "synthetic",
                        stderr: "",
                        truncated: false,
                        trust: "untrusted_host_output",
                    });
                }
            )
                .find((tool) => tool.name === "mira_homelab_resume")!
                .action({ id }, new AbortController().signal, {
                    ...current.context,
                    receiptId: resumed,
                });
        },
    };
}

async function waitForProposal(f: Awaited<ReturnType<typeof fixture>>) {
    for (let attempt = 0; attempt < 100; attempt++) {
        const [proposal] = await listMiraProposals(
            { client: f.client, owner: "operator", actor: "human:operator" },
            f.run.conversationId
        );
        if (proposal) return proposal;
        await Bun.sleep(10);
    }
    throw new Error("Expected pending host command");
}

test.each(["ask", "approve_for_me"] as const)(
    "%s waits for exact freshly verified human approval",
    async (mode) => {
        const f = await fixture(mode);
        const pending = f.invoke();
        try {
            const proposal = await waitForProposal(f);
            expect(f.calls).toEqual([]);
            await rejects(
                f.api.proposals.decide({
                    id: proposal.id,
                    inputHash: proposal.inputHash,
                    approve: true,
                }),
                /verified operator/
            );
            await rejects(
                f.approved.proposals.decide({
                    id: proposal.id,
                    inputHash: "1".repeat(64),
                    approve: true,
                }),
                /reviewed content/
            );
            await f.approved.proposals.decide({
                id: proposal.id,
                inputHash: proposal.inputHash,
                approve: true,
            });
            expect(await pending).toMatchObject({ state: "awaiting_approval" });
            expect(await f.resume()).toMatchObject({ exitCode: 0 });
            await rejects(f.resume(), /already consumed/);
            expect(f.calls).toEqual(["printf synthetic"]);
            const [receipt] = await f.client<
                { proposal: unknown }[]
            >`SELECT proposal FROM mira_tool_receipts WHERE id=${f.receiptId}`;
            expect(receipt?.proposal).toBeNull();
        } finally {
            await f.close();
        }
    }
);

test("Full access commands use provisioned authority, independent of Daytona selection", async () => {
    const f = await fixture("full_access");
    try {
        expect(await f.invoke()).toMatchObject({ stdout: "synthetic" });
        expect(f.calls).toEqual(["printf synthetic"]);
        const [receipt] = await f.client<
            { proposal: unknown; hash: string }[]
        >`SELECT proposal,input_hash AS hash FROM mira_tool_receipts WHERE id=${f.receiptId}`;
        expect(receipt?.proposal).toBeNull();
        expect(receipt?.hash).toHaveLength(64);
        expect(
            createMiraOperationsTools(f.client, f.run, {
                ...f.configuration,
                owner: "someone-else",
            })
        ).toEqual([]);
        expect(
            createMiraOperationsTools(
                f.client,
                { ...f.run, automationId: crypto.randomUUID() },
                f.configuration
            )
        ).toEqual([]);
        expect(createMiraOperationsTools(f.client, f.run)).toHaveLength(0);
    } finally {
        await f.close();
    }
});

test.each(["reject", "stop", "revoke"])(
    "%s prevents a waiting host command from executing",
    async (operation) => {
        const f = await fixture("ask");
        const pending = f.invoke();
        void pending.catch(() => {});
        try {
            const proposal = await waitForProposal(f);
            if (operation === "reject")
                await f.api.proposals.decide({
                    id: proposal.id,
                    inputHash: proposal.inputHash,
                    approve: false,
                });
            else if (operation === "stop")
                await f.client`UPDATE mira_runs SET cancel_requested=true WHERE id=${f.run.id}`;
            else
                await f.client`UPDATE mira_runs SET approval_revoked_at=clock_timestamp() WHERE id=${f.run.id}`;
            expect(await pending).toMatchObject({ state: "awaiting_approval" });
            await rejects(f.resume());
            expect(f.calls).toEqual([]);
            if (operation === "reject") {
                const [receipt] = await f.client<
                    { proposal: unknown }[]
                >`SELECT proposal FROM mira_tool_receipts WHERE id=${f.receiptId}`;
                expect(receipt?.proposal).not.toBeNull();
            }
            await rejects(
                decideMiraProposal(
                    f.context,
                    { id: proposal.id, inputHash: proposal.inputHash, approve: true },
                    true
                ),
                /signed-in operator/
            );
        } finally {
            await f.close();
        }
    }
);

test("permission revocation interrupts an already dispatched command", async () => {
    const f = await fixture("full_access");
    let started!: () => void;
    const began = new Promise<void>((resolve) => {
        started = resolve;
    });
    const tools = createMiraOperationsTools(
        f.client,
        f.run,
        f.configuration,
        async (_target, _command, signal) => {
            started();
            await new Promise<void>((_resolve, reject) =>
                signal.addEventListener(
                    "abort",
                    () => reject(new Error("Interrupted remote outcome")),
                    { once: true }
                )
            );
            throw new Error("unreachable");
        }
    );
    const pending = tools
        .find((tool) => tool.name === "mira_homelab_command")!
        .action(
            { target: "main", command: "synthetic", reason: "Revocation test" },
            new AbortController().signal,
            { ...f.context, receiptId: f.receiptId }
        );
    void pending.catch(() => {});
    try {
        await began;
        await f.client`UPDATE mira_runs SET approval_revoked_at=clock_timestamp() WHERE id=${f.run.id}`;
        await rejects(pending, /Interrupted remote outcome/);
    } finally {
        await f.close();
    }
});

test("a command that finishes while authority changes is not reported as rolled back", async () => {
    const f = await fixture("full_access");
    try {
        const tool = createMiraOperationsTools(
            f.client,
            f.run,
            f.configuration,
            async () => {
                await f.client`UPDATE mira_runs SET approval_revoked_at=clock_timestamp() WHERE id=${f.run.id}`;
                return {
                    exitCode: 0,
                    stdout: "done",
                    stderr: "",
                    truncated: false,
                    trust: "untrusted_host_output",
                };
            }
        ).find((entry) => entry.name === "mira_homelab_command")!;
        await rejects(
            tool.action(
                { target: "main", command: "synthetic", reason: "Receipt race" },
                new AbortController().signal,
                { ...f.context, receiptId: f.receiptId }
            ),
            (error: unknown) =>
                error instanceof Error &&
                !(error instanceof MiraFailure) &&
                /Reconcile/.test(error.message)
        );
    } finally {
        await f.close();
    }
});

test("the public tool wrapper preserves pending requests but stopped work cannot be approved", async () => {
    const f = await fixture("ask");
    const tool = createMiraTools(
        f.client,
        f.run,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        f.configuration
    ).find((entry) => entry.name === "mira_homelab_command")!;
    const pending = tool.execute(
        { target: "main", command: "printf synthetic", reason: "Stop while reviewing" },
        new AbortController().signal,
        { callId: crypto.randomUUID(), threadId: "fixture", turnId: "fixture" }
    );
    try {
        const proposal = await waitForProposal(f);
        await f.client`UPDATE mira_runs SET cancel_requested=true WHERE id=${f.run.id}`;
        expect(JSON.parse((await pending) as string)).toMatchObject({
            ok: true,
            result: { state: "awaiting_approval" },
        });
        await rejects(
            f.approved.proposals.decide({
                id: proposal.id,
                inputHash: proposal.inputHash,
                approve: true,
            }),
            /stopped/
        );
        const [row] = await f.client<
            { state: string; proposal: unknown }[]
        >`SELECT state,proposal FROM mira_tool_receipts WHERE id=${proposal.id}`;
        expect(row?.state).toBe("awaiting_approval");
        expect(row?.proposal).not.toBeNull();
        expect(
            await listMiraProposals(
                { client: f.client, owner: f.run.owner, actor: "human:operator" },
                f.run.conversationId
            )
        ).toHaveLength(0);
    } finally {
        await f.close();
    }
});

test("failed commands stay failed in the public wrapper while output stays out of operational receipts", async () => {
    const f = await fixture("full_access");
    const transport = spyOn(hostSsh, "executeMiraHostCommand").mockRejectedValue(
        new hostSsh.MiraHostCommandFailure({
            exitCode: 7,
            stdout: "partial output",
            stderr: "private diagnostic",
            truncated: false,
            trust: "untrusted_host_output",
        })
    );
    try {
        const tool = createMiraTools(
            f.client,
            f.run,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            f.configuration
        ).find((entry) => entry.name === "mira_homelab_command")!;
        const callId = crypto.randomUUID();
        const result = await tool.execute(
            { target: "main", command: "synthetic-failure", reason: "Failing command" },
            new AbortController().signal,
            { callId, threadId: "fixture", turnId: "fixture" }
        );
        expect(JSON.parse(result as string)).toMatchObject({
            ok: false,
            retryable: false,
            result: { exitCode: 7, stderr: "private diagnostic" },
        });
        const [receipt] = await f.client<
            { state: string; message: string; proposal: unknown }[]
        >`SELECT state,message,proposal FROM mira_tool_receipts WHERE run_id=${f.run.id} AND call_id=${callId}`;
        expect(receipt?.state).toBe("failed");
        expect(receipt?.proposal).toBeNull();
        expect(receipt?.message).not.toContain("private diagnostic");
    } finally {
        transport.mockRestore();
        await f.close();
    }
});

test("host approval survives a completed reply and resumes its exact command once", async () => {
    const f = await fixture("ask");
    try {
        await f.invoke();
        const proposal = await waitForProposal(f);
        expect(
            await finishMiraRun(f.client, f.run, {
                state: "completed",
                text: "Waiting for approval.",
                message: null,
            })
        ).toBe(true);
        expect(await f.api.proposals.list({ id: f.run.conversationId })).toHaveLength(1);
        const decision = {
            id: proposal.id,
            inputHash: proposal.inputHash,
            approve: true,
        };
        await f.approved.proposals.decide(decision);
        await f.approved.proposals.decide(decision);
        const run = await claimMiraRun(f.client, crypto.randomUUID(), "foreground");
        expect(run).not.toBeNull();
        expect(await f.resume(proposal.id, run!)).toMatchObject({ exitCode: 0 });
        await rejects(f.resume(proposal.id, run!), /already consumed/);
        expect(f.calls).toEqual(["printf synthetic"]);
    } finally {
        await f.close();
    }
});

test.each(["approve", "ask", "deny"] as const)(
    "automatic reviewer %s is separate from the requesting tool",
    async (decision) => {
        const f = await fixture("approve_for_me");
        let reviews = 0;
        try {
            const tool = createMiraOperationsTools(
                f.client,
                f.run,
                f.configuration,
                (_target, command) => {
                    f.calls.push(command.command);
                    return Promise.resolve({
                        exitCode: 0,
                        stdout: "",
                        stderr: "",
                        truncated: false,
                        trust: "untrusted_host_output",
                    });
                },
                (command) => {
                    reviews++;
                    expect(command.command).toBe("printf synthetic");
                    return Promise.resolve({
                        decision,
                        reason: "Synthetic review verdict",
                    });
                }
            ).find((entry) => entry.name === "mira_homelab_command")!;
            const result = await tool.action(
                {
                    target: "main",
                    command: "printf synthetic",
                    reason: "Requested fixture",
                },
                new AbortController().signal,
                { ...f.context, receiptId: f.receiptId }
            );
            expect(reviews).toBe(1);
            expect(f.calls).toHaveLength(decision === "approve" ? 1 : 0);
            expect(result).toMatchObject(
                decision === "approve" ? { exitCode: 0 } : { state: "awaiting_approval" }
            );
        } finally {
            await f.close();
        }
    }
);

test("revoking permissions during automatic review prevents automatic execution", async () => {
    const f = await fixture("approve_for_me");
    try {
        const tool = createMiraOperationsTools(
            f.client,
            f.run,
            f.configuration,
            () => Promise.reject(new Error("Must not dispatch")),
            async () => {
                await f.client`UPDATE mira_runs SET approval_revoked_at=clock_timestamp() WHERE id=${f.run.id}`;
                return { decision: "approve", reason: "Too late" };
            }
        ).find((entry) => entry.name === "mira_homelab_command")!;
        await rejects(
            tool.action(
                { target: "main", command: "printf synthetic", reason: "Revoked review" },
                new AbortController().signal,
                { ...f.context, receiptId: f.receiptId }
            ),
            /Permissions changed/
        );
    } finally {
        await f.close();
    }
});

test("questions survive completion and permission edits, then queue one continuation", async () => {
    const f = await fixture("ask");
    try {
        // The fixture's unused host receipt is unrelated to this question.
        await f.client`UPDATE mira_tool_receipts SET state='failed' WHERE id=${f.receiptId}`;
        const tool = createMiraTools(f.client, f.run).find(
            (entry) => entry.name === "mira_request_user_input"
        )!;
        const result: unknown = JSON.parse(
            (await tool.execute(
                {
                    questions: [
                        {
                            id: "target",
                            title: "Which target?",
                            options: ["Main", "Daytona"],
                        },
                        { id: "details", title: "Any constraints?" },
                    ],
                },
                new AbortController().signal,
                { callId: crypto.randomUUID(), threadId: "fixture", turnId: "fixture" }
            )) as string
        );
        expect(result).toMatchObject({ ok: true });
        const [proposal] = await f.api.proposals.list({ id: f.run.conversationId });
        expect(proposal?.tool).toBe("mira_request_user_input");
        await finishMiraRun(f.client, f.run, {
            state: "completed",
            text: "Waiting for your choices.",
            message: null,
        });
        const chat = await f.api.conversations.read({ id: f.run.conversationId });
        await f.api.conversations.settings({
            id: f.run.conversationId,
            version: chat.conversation.version,
            settings: { ...chat.conversation.settings, permissionMode: "full_access" },
        });
        expect(await f.api.proposals.list({ id: f.run.conversationId })).toHaveLength(1);
        await rejects(
            f.api.proposals.answer({
                id: proposal!.id,
                inputHash: "1".repeat(64),
                answers: { target: "Main", details: "No downtime" },
            }),
            /differs/
        );
        await rejects(
            f.api.proposals.answer({
                id: proposal!.id,
                inputHash: proposal!.inputHash,
                answers: { target: "Main" },
            }),
            /every question/
        );
        const answer = {
            id: proposal!.id,
            inputHash: proposal!.inputHash,
            answers: { target: "A custom target", details: "No downtime" },
        };
        expect(await f.api.proposals.answer(answer)).toMatchObject({ state: "answered" });
        const [message] = await f.client<
            { content: string }[]
        >`SELECT m.content FROM mira_messages m JOIN mira_runs r ON r.user_message_id=m.id WHERE r.request_key=${`operator:${proposal!.id}`}`;
        expect(message?.content).toBe("A custom target\n\nNo downtime");
        const [question] = await f.client<
            { content: string }[]
        >`SELECT content FROM mira_messages WHERE id=${proposal!.id}`;
        expect(question?.content).toBe("Which target?\n\nAny constraints?");
        expect(await f.api.proposals.answer(answer)).toMatchObject({ state: "answered" });
        await rejects(
            f.api.proposals.answer({
                ...answer,
                answers: { target: "Changed", details: "No downtime" },
            }),
            /already answered/
        );
        expect(await f.api.proposals.list({ id: f.run.conversationId })).toHaveLength(0);
        const runs = await f.client<
            { id: string }[]
        >`SELECT id FROM mira_runs WHERE conversation_id=${f.run.conversationId} AND state='queued'`;
        expect(runs).toHaveLength(1);
    } finally {
        await f.close();
    }
});

test.each(["consumed", "expired"] as const)(
    "%s requests do not block a fresh review of the same host command",
    async (previous) => {
        const f = await fixture("ask");
        try {
            await f.invoke();
            const proposal = await waitForProposal(f);
            if (previous === "consumed") {
                await f.approved.proposals.decide({
                    id: proposal.id,
                    inputHash: proposal.inputHash,
                    approve: true,
                });
                await f.resume();
            } else {
                await f.client`UPDATE mira_tool_receipts SET created_at=clock_timestamp()-interval '25 hours' WHERE id=${proposal.id}`;
            }
            const id = crypto.randomUUID();
            await f.client`INSERT INTO mira_tool_receipts(id,run_id,call_id,tool,input_hash,state) VALUES(${id},${f.run.id},${id},'mira_homelab_command',${"0".repeat(64)},'running')`;
            expect(await f.invoke(undefined, id)).toMatchObject({
                requestId: id,
                state: "awaiting_approval",
            });
            const pending = await f.api.proposals.list({ id: f.run.conversationId });
            expect(pending).toHaveLength(1);
            expect(pending[0]?.id).toBe(id);
            expect(f.calls).toHaveLength(previous === "consumed" ? 1 : 0);
        } finally {
            await f.close();
        }
    }
);

test("a reserved receipt can save a fresh approval after a permission edit", async () => {
    const f = await fixture("full_access");
    try {
        // Reservation precedes the edit; authorization happens when the tool runs.
        const fresh = crypto.randomUUID();
        await f.client`INSERT INTO mira_tool_receipts(id,run_id,call_id,tool,input_hash,state) VALUES(${fresh},${f.run.id},${fresh},'mira_homelab_command',${"0".repeat(64)},'running')`;
        const chat = await f.api.conversations.read({ id: f.run.conversationId });
        await f.api.conversations.settings({
            id: f.run.conversationId,
            version: chat.conversation.version,
            settings: { ...chat.conversation.settings, permissionMode: "ask" },
        });
        expect(await f.invoke(new AbortController().signal, fresh)).toMatchObject({
            state: "awaiting_approval",
        });
        const [proposal] = await listMiraProposals(
            { client: f.client, owner: "operator", actor: "human:operator" },
            f.run.conversationId
        );
        expect(proposal?.id).toBe(fresh);
        await f.approved.proposals.decide({
            id: fresh,
            inputHash: proposal!.inputHash,
            approve: true,
        });
        await f.resume(fresh);
        expect(f.calls).toEqual(["printf synthetic"]);
        await rejects(f.resume(fresh));
        expect(f.calls).toHaveLength(1);
    } finally {
        await f.close();
    }
});
