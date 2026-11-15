import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";

import { capabilities } from "@homelab/contracts/operations";
import { MiraFailure } from "@homelab/mira/data/context";
import { decideMiraProposal, listMiraProposals } from "@homelab/mira/data/proposals";
import { createMiraOperationsTools } from "@homelab/mira/operations/tools";

import { createMiraTools } from "../../../../mira/src/server/executor/tools";
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
    const invoke = (signal = new AbortController().signal) =>
        tools
            .find((tool) => tool.name === "mira_homelab_command")!
            .action(
                {
                    target: "main",
                    command: "printf synthetic",
                    reason: "Test exact approval",
                },
                signal,
                { ...current.context, receiptId }
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
            expect(await pending).toMatchObject({ exitCode: 0 });
            expect(f.calls).toEqual(["printf synthetic"]);
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
            { input: { command: string; binding: string } }[]
        >`SELECT proposal AS input FROM mira_tool_receipts WHERE id=${f.receiptId}`;
        expect(receipt?.input.command).toBe("printf synthetic");
        expect(receipt?.input.binding).toHaveLength(64);
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
            await rejects(pending);
            expect(f.calls).toEqual([]);
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

test("the public tool wrapper expires pending approvals when the operator stops", async () => {
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
        expect(JSON.parse((await pending) as string)).toMatchObject({ ok: false });
        const [row] = await f.client<
            { state: string }[]
        >`SELECT state FROM mira_tool_receipts WHERE id=${proposal.id}`;
        expect(row?.state).toBe("expired");
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
