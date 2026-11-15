import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";

import { capabilities } from "@homelab/contracts/operations";
import { miraObservationFingerprint } from "@homelab/mira/data/notifications";
import { claimMiraRun } from "@homelab/mira/data/queue";
import { resolveMiraRun } from "@homelab/mira/data/runResolution";
import * as v from "valibot";

import { appRouter } from "../api/router";
import { createMiraTextTestTools } from "../testing/miraTools";
import { operationFixture } from "../testing/operations";

async function fixture() {
    const db = await operationFixture();
    const api = appRouter.createCaller({
        operations: db,
        principal: { kind: "human", id: "operator", capabilities },
    }).mira;
    const chat = await api.conversations.create({ title: "Follow-up fixture" });
    await api.conversations.send({
        conversationId: chat.id,
        requestId: crypto.randomUUID(),
        text: "Inspect the recorded results.",
    });
    const run = await claimMiraRun(db.client, crypto.randomUUID(), "foreground");
    if (!run) throw new Error("Missing inspector run");
    const historical = async (state: string, owner = "operator") => {
        const id = Bun.randomUUIDv7();
        await db.client`INSERT INTO mira_runs (id,owner,state,request_key,request_hash,conversation_id,user_message_id,assistant_message_id,priority,budget_seconds,message) VALUES (${id},${owner},${state},${`fixture:${id}`},'fixture',${chat.id},${run.userMessageId},${run.assistantMessageId},1,60,'Recorded action outcome remains uncertain')`;
        return id;
    };
    const readTool = async (input: Record<string, unknown> = {}) => {
        const tool = createMiraTextTestTools(db.client, {
            ...run,
            automationId: crypto.randomUUID(),
        }).find((item) => item.name === "mira_runs_list")!;
        const outputSchema = v.object({
            ok: v.literal(true),
            result: v.object({
                rows: v.array(
                    v.object({
                        id: v.string(),
                        state: v.string(),
                        followupResolution: v.unknown(),
                        uncertainActions: v.number(),
                    })
                ),
                recentlyClosed: v.array(
                    v.object({
                        id: v.string(),
                        title: v.string(),
                        resolution: v.object({
                            reason: v.string(),
                            outcome: v.string(),
                        }),
                    })
                ),
            }),
        });
        return v.parse(
            outputSchema,
            JSON.parse(
                await tool.execute(input, new AbortController().signal, {
                    callId: crypto.randomUUID(),
                    threadId: "fixture",
                    turnId: "fixture",
                })
            ) as unknown
        ).result;
    };
    return { ...db, api, chat, run, historical, readTool };
}

test.each(["reviewed", "dismissed"] as const)(
    "%s follow-up is owned, durable and leaves execution evidence unchanged without starting work",
    async (outcome) => {
        const f = await fixture();
        try {
            const id = await f.historical("needs_attention");
            await f.client`INSERT INTO mira_tool_receipts (id,run_id,call_id,tool,input_hash,state) VALUES (${Bun.randomUUIDv7()},${id},'uncertain','computer_click','fixture','unknown')`;
            const other = await f.historical("failed", "other");
            const input = { id, outcome, reason: "No longer relevant to the operator." };
            await rejects(f.api.runs.resolve({ ...input, id: other }), /Run not found/);
            await rejects(
                resolveMiraRun(
                    {
                        client: f.client,
                        owner: "operator",
                        actor: "mira",
                        run: { id: f.run.id, leaseToken: f.run.leaseToken },
                    },
                    input
                ),
                /Only the operator/
            );
            const unresolved = await f.readTool();
            expect(unresolved.rows.map((row) => row.id)).toEqual([id]);
            const closed = await f.api.runs.resolve(input);
            expect(closed).toMatchObject({
                outcome,
                reason: input.reason,
                closedBy: "human:operator",
            });
            expect(await f.api.runs.resolve(input)).toEqual(closed);
            await rejects(
                f.api.runs.resolve({ ...input, reason: "A different reason" }),
                /already closed/
            );
            const detail = await f.api.runs.read({ id });
            expect(detail.run).toMatchObject({
                state: "needs_attention",
                followupResolution: closed,
            });
            expect(detail.rows[0]!.state).toBe("unknown");
            const current = await f.readTool();
            expect(current.rows).toEqual([]);
            expect(current.recentlyClosed).toEqual([
                {
                    id,
                    title: "Follow-up fixture",
                    resolution: { outcome, reason: input.reason },
                },
            ]);
            const history = await f.readTool({ includeResolved: true });
            expect(history.rows).toMatchObject([
                {
                    id,
                    state: "needs_attention",
                    followupResolution: closed,
                    uncertainActions: 1,
                },
            ]);
            const [audit] = await f.client<
                { count: number }[]
            >`SELECT count(*)::int AS count FROM mira_audit WHERE target=${id} AND action='run.followup_closed'`;
            expect(audit!.count).toBe(1);
            const [active] = await f.client<
                { count: number }[]
            >`SELECT count(*)::int AS count FROM mira_runs WHERE owner='operator' AND state IN ('running','queued')`;
            expect(active!.count).toBe(1);
        } finally {
            await f.close();
        }
    }
);

test("active work, successful work and invalid reasons cannot be dismissed", async () => {
    const f = await fixture();
    try {
        const completed = await f.historical("completed");
        for (const id of [f.run.id, completed])
            await rejects(
                f.api.runs.resolve({
                    id,
                    outcome: "dismissed",
                    reason: "Unneeded follow-up",
                }),
                /no terminal follow-up/
            );
        const failed = await f.historical("failed");
        for (const reason of ["  ", "x".repeat(2001)])
            await rejects(
                f.api.runs.resolve({ id: failed, outcome: "dismissed", reason })
            );
        const detail = await f.api.runs.read({ id: failed });
        expect(detail.run.followupResolution).toBeNull();
    } finally {
        await f.close();
    }
});

test("closing older history changes the heartbeat fingerprint beyond the recent run window", async () => {
    const f = await fixture();
    try {
        const id = await f.historical("failed");
        for (let index = 0; index < 31; index++) await f.historical("completed");
        const fingerprint = () =>
            f.client.begin((query) =>
                miraObservationFingerprint(query, "operator", f.run.id)
            );
        const before = await fingerprint();
        await f.api.runs.resolve({
            id,
            outcome: "dismissed",
            reason: "Historical task is no longer relevant.",
        });
        expect(await fingerprint()).not.toBe(before);
    } finally {
        await f.close();
    }
});

test("deleted conversations retain owned follow-up decisions without disclosing their old title", async () => {
    const f = await fixture();
    try {
        const id = await f.historical("failed");
        await f.client`UPDATE mira_conversations SET deleted_at=now() WHERE id=${f.chat.id}`;
        await f.api.runs.resolve({
            id,
            outcome: "dismissed",
            reason: "Historical task is no longer relevant.",
        });
        const history = await f.readTool();
        expect(history.recentlyClosed).toEqual([
            {
                id,
                title: "Deleted conversation",
                resolution: {
                    outcome: "dismissed",
                    reason: "Historical task is no longer relevant.",
                },
            },
        ]);
        expect(history.rows).toEqual([]);
        const detail = await f.api.runs.read({ id });
        expect(detail.run.followupResolution?.outcome).toBe("dismissed");
    } finally {
        await f.close();
    }
});
