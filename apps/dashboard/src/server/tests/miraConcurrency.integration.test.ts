import { expect, test } from "bun:test";

import { capabilities } from "@homelab/contracts/operations";
import {
    claimMiraRun,
    finishMiraRun,
    renewMiraRun,
    scheduleMiraRuns,
} from "@homelab/mira/data/queue";

import { appRouter } from "../api/router";
import { operationFixture } from "../testing/operations";

test("scheduled automations and multiple chats hold independent leases concurrently", async () => {
    const database = await operationFixture();
    const api = appRouter.createCaller({
        operations: database,
        principal: { kind: "human", id: "operator", capabilities },
    }).mira;
    try {
        const manual: string[] = [];
        for (const title of ["First chat", "Second chat"]) {
            const chat = await api.conversations.create({ title });
            const run = await api.conversations.send({
                conversationId: chat.id,
                requestId: crypto.randomUUID(),
                text: "Synthetic concurrent work",
            });
            manual.push(run.id);
        }
        const at = new Date(Date.now() + 60_000);
        for (const title of ["Evening summary", "Other automation"]) {
            const automation = await api.automations.create({
                title,
                prompt: "Synthetic scheduled work",
                kind: "custom",
                schedule: { kind: "once", at: at.toISOString() },
                budgetSeconds: 60,
            });
            await api.controls.setEnabled({
                key: `automation:${automation.id}`,
                version: 1,
                enabled: true,
                reason: null,
                until: null,
            });
        }
        const scheduledAt = new Date(at.getTime() + 1);
        expect(await scheduleMiraRuns(database.client, scheduledAt)).toBe(2);
        const claims = await Promise.all(
            Array.from({ length: 4 }, () =>
                claimMiraRun(database.client, crypto.randomUUID(), "general")
            )
        );
        expect(claims.every((run) => run !== null)).toBe(true);
        expect(new Set(claims.map((run) => run?.id)).size).toBe(4);
        expect(claims.filter((run) => run?.automationId)).toHaveLength(2);
        expect(claims.filter((run) => manual.includes(run!.id))).toHaveLength(2);
        expect(
            await claimMiraRun(database.client, crypto.randomUUID(), "general")
        ).toBeNull();

        const extra = await api.conversations.create({ title: "Another chat" });
        const queued = await api.conversations.send({
            conversationId: extra.id,
            requestId: crypto.randomUUID(),
            text: "Start while the other runs are active",
        });
        const foreground = await claimMiraRun(
            database.client,
            crypto.randomUUID(),
            "foreground"
        );
        expect(foreground?.id).toBe(queued.id);
        await api.runs.cancel({ id: claims[0]!.id });
        expect(await renewMiraRun(database.client, claims[0]!)).toBe(false);
        for (const run of [...claims.slice(1), foreground]) {
            expect(await renewMiraRun(database.client, run!)).toBe(true);
            expect(
                await finishMiraRun(database.client, run!, {
                    state: "completed",
                    text: "Independent synthetic completion",
                    message: null,
                })
            ).toBe(true);
        }
        expect(
            await finishMiraRun(database.client, claims[0]!, {
                state: "interrupted",
                text: "",
                message: null,
            })
        ).toBe(true);
    } finally {
        await database.close();
    }
});

test("manual backlogs preserve bounded automatic capacity", async () => {
    const database = await operationFixture();
    const api = appRouter.createCaller({
        operations: database,
        principal: { kind: "human", id: "operator", capabilities },
    }).mira;
    const chat = async (title: string) => {
        const conversation = await api.conversations.create({ title });
        return api.conversations.send({
            conversationId: conversation.id,
            requestId: crypto.randomUUID(),
            text: "Synthetic queued work",
        });
    };
    const claim = (lane: "foreground" | "general") =>
        claimMiraRun(database.client, crypto.randomUUID(), lane);
    try {
        for (const title of ["Long chat one", "Long chat two"]) {
            const queued = await chat(title);
            const claimed = await claim("general");
            expect(claimed?.id).toBe(queued.id);
        }
        const waiting = await chat("Manual backlog");
        const at = new Date(Date.now() + 60_000);
        for (const title of ["Scheduled summary", "Scheduled brief"]) {
            const automation = await api.automations.create({
                title,
                prompt: "Synthetic automatic work",
                kind: "custom",
                schedule: { kind: "once", at: at.toISOString() },
                budgetSeconds: 60,
            });
            await api.controls.setEnabled({
                key: `automation:${automation.id}`,
                version: 1,
                enabled: true,
                reason: null,
                until: null,
            });
        }
        const scheduledAt = new Date(at.getTime() + 1);
        expect(await scheduleMiraRuns(database.client, scheduledAt)).toBe(2);
        const automatic = await Promise.all([claim("general"), claim("general")]);
        expect(automatic.every((run) => run?.automationId)).toBe(true);
        expect(await claim("general")).toBeNull();
        const first = await claim("foreground");
        expect(first?.id).toBe(waiting.id);
        for (const title of ["Chat four", "Chat five", "Chat six"]) {
            const queued = await chat(title);
            const claimed = await claim("foreground");
            expect(claimed?.id).toBe(queued.id);
        }
        const later = await chat("Wait for capacity");
        expect(await claim("foreground")).toBeNull();
        expect(await claim("general")).toBeNull();
        for (const run of automatic) {
            expect(await renewMiraRun(database.client, run!)).toBe(true);
        }
        expect(
            await finishMiraRun(database.client, first!, {
                state: "completed",
                text: "Released one foreground slot",
                message: null,
            })
        ).toBe(true);
        const resumed = await claim("foreground");
        expect(resumed?.id).toBe(later.id);
    } finally {
        await database.close();
    }
});
