import { expect, spyOn, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { miraDefaultChatSettings, miraModelSchema } from "@homelab/contracts/mira";
import { capabilities } from "@homelab/contracts/operations";
import { recordMiraEvent } from "@homelab/mira/data/events";
import { saveMiraFile } from "@homelab/mira/data/files";
import { claimMiraRun, finishMiraRun, scheduleMiraRuns } from "@homelab/mira/data/queue";
import * as v from "valibot";

import { readMiraTurnInput } from "../../../../mira/src/server/executor/context";
import { executeMiraTurn } from "../../../../mira/src/server/executor/turn";
import { syntheticModels } from "../../../../mira/src/server/runtime/syntheticCatalog";
import { appRouter } from "../api/router";
import { operationFixture } from "../testing/operations";

const selection = { model: "syn:large:text", effort: "high", serviceTier: null };
const providerModel = {
    id: selection.model,
    alias_of: "Fixture target",
    always_on: true,
    supported_features: ["tools", "reasoning"],
    input_modalities: ["text", "image"],
    output_modalities: ["text"],
    reasoning_parameters: { efforts: ["low", "high"] },
};
const catalog = [
    v.parse(miraModelSchema, { model: "native-fixture", isDefault: true }),
    ...syntheticModels({ data: [providerModel] }),
];
const page = { search: "", archived: false };

async function fixture() {
    const database = await operationFixture();
    const api = (owner = "operator") =>
        appRouter.createCaller({
            operations: database,
            principal: { kind: "human", id: owner, capabilities },
        }).mira;
    await database.client`INSERT INTO mira_runtime_status(id,worker_id,version,model,ready,heartbeat_at,models,synthetic_owner) VALUES (1,${crypto.randomUUID()},'fixture','native-fixture',true,now(),${JSON.stringify(catalog)}::text::jsonb,'operator')`;
    return { ...database, api };
}

test("provider choices are owned and automation runs freeze their selected alias and thinking level", async () => {
    const database = await fixture();
    try {
        const ownModels = await database.api().models();
        const otherModels = await database.api("other").models();
        expect(ownModels.models.map((model) => model.model)).toEqual([
            "native-fixture",
            selection.model,
        ]);
        expect(otherModels.models.map((model) => model.model)).toEqual([
            "native-fixture",
        ]);
        const input = {
            title: "Fixture automation",
            prompt: "Read fixture",
            kind: "custom" as const,
            delivery: "silent" as const,
            schedule: { kind: "daily" as const, time: "09:30" },
            budgetSeconds: 60,
            settings: selection,
        };
        await rejects(database.api("other").automations.create(input), /unavailable/);
        await rejects(
            database.api().automations.create({
                ...input,
                settings: { ...selection, effort: "max" },
            }),
            /thinking/
        );
        const automation = await database.api().automations.create(input);
        const run = await database
            .api()
            .automations.run({ id: automation.id, requestId: crypto.randomUUID() });
        const [stored] = await database.client<
            { settings: unknown; chatSettings: unknown }[]
        >`SELECT r.settings,c.settings AS "chatSettings" FROM mira_runs r JOIN mira_conversations c ON c.id=r.conversation_id WHERE r.id=${run.id}`;
        expect(stored?.settings).toEqual(selection);
        expect(stored?.chatSettings).toEqual(selection);
        await database.api().automations.update({
            ...input,
            id: automation.id,
            version: 1,
            settings: miraDefaultChatSettings,
        });
        const [unchanged] = await database.client<
            { settings: unknown }[]
        >`SELECT settings FROM mira_runs WHERE id=${run.id}`;
        expect(unchanged?.settings).toEqual(selection);
        const controls = await database.api().controls.list();
        expect(
            controls.find((control) => control.key === `automation:${automation.id}`)
                ?.enabled
        ).toBe(false);
        const { settings: _settings, ...legacy } = input;
        await database
            .api()
            .automations.update({ ...legacy, id: automation.id, version: 2 });
        const definitions = await database.api().automations.list(page);
        expect(definitions.rows[0]?.settings).toEqual(miraDefaultChatSettings);
    } finally {
        await database.close();
    }
});

test("automatic models remain owner-specific across chat, saved preferences, schedules and events", async () => {
    const database = await fixture();
    const directory = await mkdtemp(path.join(tmpdir(), "mira-owner-default-"));
    try {
        const models = [
            v.parse(miraModelSchema, { model: "synthetic", isDefault: true }),
            ...catalog.slice(1),
        ];
        await database.client`UPDATE mira_runtime_status SET model=${selection.model},models=${JSON.stringify(models)}::text::jsonb WHERE id=1`;
        const available = {
            models: models.map((entry) => entry.model),
            defaultModel: selection.model,
            nativeDefaultModel: "synthetic",
            syntheticOwner: "operator",
        };
        const ownCatalog = await database.api().models();
        const otherCatalog = await database.api("other").models();
        expect(ownCatalog.defaultModel).toBe(selection.model);
        expect(otherCatalog.defaultModel).toBe("synthetic");
        for (const owner of ["operator", "other"]) {
            const api = database.api(owner);
            const chat = await api.conversations.create({ title: "Automatic model" });
            const detail = await api.conversations.read({ id: chat.id });
            await api.conversations.settings({
                id: chat.id,
                version: detail.conversation.version,
                settings: miraDefaultChatSettings,
            });
            await api.conversations.send({
                conversationId: chat.id,
                requestId: crypto.randomUUID(),
                text: "Use my default.",
            });
            const run = (await claimMiraRun(
                database.client,
                crypto.randomUUID(),
                "foreground",
                available
            ))!;
            expect(run.owner).toBe(owner);
            const input = await readMiraTurnInput(database.client, run);
            expect(input.settings.model).toBe(
                owner === "operator" ? selection.model : "synthetic"
            );
            if (owner === "operator")
                await finishMiraRun(database.client, run, {
                    state: "completed",
                    text: "Fixture",
                    message: null,
                });
            else {
                const command = path.join(directory, "fixture-codex");
                const home = path.join(directory, "home");
                await mkdir(home);
                const child = fileURLToPath(
                    new URL(
                        "../../../../mira/src/server/testing/runtimeChild.ts",
                        import.meta.url
                    )
                );
                await writeFile(
                    command,
                    `#!/usr/bin/env bun\nprocess.argv=[process.argv[0],${JSON.stringify(child)},'settings-activity',${JSON.stringify(home)}];\nawait import(${JSON.stringify(child)});\n`
                );
                await chmod(command, 0o700);
                await executeMiraTurn(
                    database.client,
                    {
                        command,
                        codexHome: home,
                        workspace: directory,
                        model: selection.model,
                    },
                    run,
                    new AbortController().signal,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    undefined,
                    { owner: "operator", apiKey: "must-not-use" }
                );
                const [result] = await database.client<
                    { state: string; settings: { model: string } }[]
                >`SELECT state,effective_settings AS settings FROM mira_runs WHERE id=${run.id}`;
                expect(result?.state).toBe("completed");
                expect(result?.settings.model).toBe("synthetic");
            }
        }
        const past = new Date(Date.now() - 1000);
        for (const schedule of [
            { kind: "once", at: past.toISOString() },
            { kind: "event", event: "task_due" },
        ]) {
            const id = Bun.randomUUIDv7();
            await database.client`INSERT INTO mira_automations(id,owner,title,prompt,kind,schedule,budget_seconds,next_run_at) VALUES (${id},'other','Default automation','Read fixture','custom',${JSON.stringify(schedule)}::text::jsonb,60,${schedule.kind === "once" ? past : null})`;
            await database.client`INSERT INTO mira_switches(owner,key,enabled,changed_at) VALUES ('other',${`automation:${id}`},true,${past})`;
        }
        await database.client.begin((query) =>
            recordMiraEvent(query, {
                owner: "other",
                kind: "task_due",
                key: "owned-default",
                reference: "Fixture",
            })
        );
        expect(
            await scheduleMiraRuns(database.client, new Date(), {
                ...available,
                models: [selection.model],
                nativeDefaultModel: null,
            })
        ).toBe(0);
        expect(await scheduleMiraRuns(database.client, new Date(), available)).toBe(2);
        for (let count = 0; count < 2; count++) {
            const run = (await claimMiraRun(
                database.client,
                crypto.randomUUID(),
                "general",
                available
            ))!;
            expect(run.owner).toBe("other");
            const input = await readMiraTurnInput(database.client, run);
            expect(input.settings.model).toBe("synthetic");
            await finishMiraRun(database.client, run, {
                state: "completed",
                text: "Fixture",
                message: null,
            });
        }
    } finally {
        await database.close();
        await rm(directory, { recursive: true, force: true });
    }
});

test("explicit automation models run while an unavailable default waits and cannot consume another owner's subscription", async () => {
    const database = await fixture();
    try {
        const past = new Date(Date.now() - 1000);
        // A full older batch from other accounts must not hide the available owner.
        for (let index = 0; index < 20; index++) {
            await database.client`INSERT INTO mira_automations(id,owner,title,prompt,kind,schedule,budget_seconds,next_run_at) VALUES (${Bun.randomUUIDv7()},${`unavailable-${index}`},'Waiting','Fixture','custom',${JSON.stringify({ kind: "once", at: past.toISOString() })}::text::jsonb,60,${new Date(past.getTime() - 1000)})`;
        }
        for (const [owner, settings] of [
            ["operator", selection],
            ["operator", miraDefaultChatSettings],
            ["other", selection],
        ] as const) {
            const id = Bun.randomUUIDv7();
            await database.client`INSERT INTO mira_automations(id,owner,title,prompt,kind,schedule,budget_seconds,next_run_at,settings) VALUES (${id},${owner},'Fixture','Read fixture','custom',${JSON.stringify({ kind: "once", at: past.toISOString() })}::text::jsonb,60,${past},${JSON.stringify(settings)}::text::jsonb)`;
            await database.client`INSERT INTO mira_switches(owner,key,enabled) VALUES (${owner},${`automation:${id}`},true)`;
        }
        const available = {
            models: [selection.model],
            defaultModel: "removed-native",
            syntheticOwner: "operator",
        };
        expect(await scheduleMiraRuns(database.client, new Date(), available)).toBe(1);
        const run = await claimMiraRun(
            database.client,
            crypto.randomUUID(),
            "general",
            available
        );
        expect(run?.owner).toBe("operator");
        const input = await readMiraTurnInput(database.client, run!);
        expect(input.settings).toEqual(selection);
        expect(
            await claimMiraRun(
                database.client,
                crypto.randomUUID(),
                "foreground",
                available
            )
        ).toBeNull();
        const [waiting] = await database.client<
            { count: number }[]
        >`SELECT count(*)::int AS count FROM mira_automations WHERE next_run_at IS NOT NULL`;
        expect(waiting?.count).toBe(22);
    } finally {
        await database.close();
    }
});

test("event deliveries wait for their selected provider and snapshot settings once it returns", async () => {
    const database = await fixture();
    try {
        const api = database.api();
        const automation = await api.automations.create({
            title: "Review due event",
            prompt: "Read current event",
            kind: "custom",
            schedule: { kind: "event", event: "task_due" },
            budgetSeconds: 60,
            settings: selection,
        });
        await api.controls.setEnabled({
            key: `automation:${automation.id}`,
            enabled: true,
            version: 1,
            reason: null,
            until: null,
        });
        await database.client.begin((query) =>
            recordMiraEvent(query, {
                owner: "operator",
                kind: "task_due",
                key: "provider-fixture-event",
                reference: "Fixture",
            })
        );
        expect(
            await scheduleMiraRuns(database.client, new Date(), {
                models: ["native-fixture"],
                defaultModel: "native-fixture",
                syntheticOwner: "operator",
            })
        ).toBe(0);
        const [pending] = await database.client<
            { state: string }[]
        >`SELECT state FROM mira_event_deliveries WHERE automation_id=${automation.id}`;
        expect(pending?.state).toBe("pending");
        expect(
            await scheduleMiraRuns(database.client, new Date(), {
                models: [selection.model],
                defaultModel: "unavailable",
                syntheticOwner: "operator",
            })
        ).toBe(1);
        const [run] = await database.client<
            { settings: unknown }[]
        >`SELECT settings FROM mira_runs WHERE automation_id=${automation.id}`;
        expect(run?.settings).toEqual(selection);
        expect(await scheduleMiraRuns(database.client)).toBe(0);
    } finally {
        await database.close();
    }
});

test("Synthetic server execution restores product history and preserves native cleanup references", async () => {
    const database = await fixture();
    const directory = await mkdtemp(path.join(tmpdir(), "mira-provider-history-"));
    const textModel = {
        ...providerModel,
        id: "syn:small:text",
        input_modalities: ["text"],
    };
    const bodies: Record<string, unknown>[] = [];
    const nativeFetch = fetch;
    const provider = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
            const url = new URL(request.url);
            if (url.pathname.endsWith("/models"))
                return Response.json({ data: [providerModel, textModel] });
            if (url.pathname.endsWith("/quotas"))
                return Response.json({ subscription: { limit: 100, requests: 0 } });
            return request.json().then((body) => {
                bodies.push(v.parse(v.record(v.string(), v.unknown()), body));
                return new Response(
                    'data: {"choices":[{"index":0,"delta":{"content":"Remembered the fixture."},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                    { headers: { "content-type": "text/event-stream" } }
                );
            });
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
        await database.client`INSERT INTO mira_memory(id,owner,title,content) VALUES(${Bun.randomUUIDv7()},'operator','Preference','CURRENT MEMORY SYN-981')`;
        await database.client`UPDATE mira_runtime_status SET models=${JSON.stringify([...catalog, ...syntheticModels({ data: [textModel] })])}::text::jsonb WHERE id=1`;
        const image = await saveMiraFile(
            { client: database.client, owner: "operator", actor: "human:operator" },
            directory,
            {
                id: crypto.randomUUID(),
                name: "fixture.png",
                bytes: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]),
            }
        );
        const chat = await database
            .api()
            .conversations.create({ title: "Provider switch" });
        await database.api().conversations.send({
            conversationId: chat.id,
            requestId: crypto.randomUUID(),
            text: "Remember fixture ZK-427.",
            attachmentIds: [image.id],
        });
        const initial = await claimMiraRun(
            database.client,
            crypto.randomUUID(),
            "foreground"
        );
        await finishMiraRun(database.client, initial!, {
            state: "completed",
            text: "Noted.",
            message: null,
        });
        const detail = await database.api().conversations.read({ id: chat.id });
        await database.api().conversations.settings({
            id: chat.id,
            version: detail.conversation.version,
            settings: selection,
        });
        await database.client`UPDATE mira_conversations SET provider_thread='native-reference',provider_context_ready=true WHERE id=${chat.id}`;
        await database.api().conversations.send({
            conversationId: chat.id,
            requestId: crypto.randomUUID(),
            text: "What was the fixture?",
        });
        const run = await claimMiraRun(
            database.client,
            crypto.randomUUID(),
            "foreground"
        );
        await executeMiraTurn(
            database.client,
            { command: "/must-not-run", workspace: directory, codexHome: directory },
            run!,
            new AbortController().signal,
            directory,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            { owner: "operator", apiKey: "fixture-subscription-key" }
        );
        expect(bodies).toHaveLength(1);
        expect(bodies[0]?.model).toBe(selection.model);
        expect(JSON.stringify(bodies[0])).toContain("ZK-427");
        expect(JSON.stringify(bodies[0])).toContain("CURRENT MEMORY SYN-981");
        expect(JSON.stringify(bodies[0])).toContain("data:image/png;base64,");
        const [stored] = await database.client<
            { state: string; ready: boolean; reference: string }[]
        >`SELECT r.state,c.provider_context_ready AS ready,c.provider_thread AS reference FROM mira_runs r JOIN mira_conversations c ON c.id=r.conversation_id WHERE r.id=${run!.id}`;
        expect(stored).toEqual({
            state: "completed",
            ready: false,
            reference: "native-reference",
        });
        await rejects(
            readMiraTurnInput(database.client, { ...run!, owner: "other" }, true),
            /unavailable/
        );
        const current = await database.api().conversations.read({ id: chat.id });
        await database.api().conversations.settings({
            id: chat.id,
            version: current.conversation.version,
            settings: {
                ...selection,
                model: textModel.id,
                useMemory: false,
                useHistory: false,
            },
        });
        for (const attach of [false, true]) {
            await database.api().conversations.send({
                conversationId: chat.id,
                requestId: crypto.randomUUID(),
                text: "Continue in text.",
                attachmentIds: attach ? [image.id] : [],
            });
            const next = (await claimMiraRun(
                database.client,
                crypto.randomUUID(),
                "foreground"
            ))!;
            await executeMiraTurn(
                database.client,
                { command: "/must-not-run", workspace: directory, codexHome: directory },
                next,
                new AbortController().signal,
                directory,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                { owner: "operator", apiKey: "fixture-subscription-key" }
            );
            const [result] = await database.client<
                { state: string; message: string | null }[]
            >`SELECT state,message FROM mira_runs WHERE id=${next.id}`;
            expect(result?.state).toBe(attach ? "needs_attention" : "completed");
            if (attach) expect(result?.message).toContain("does not support images");
            expect(bodies).toHaveLength(2);
        }
        expect(bodies[1]?.model).toBe(textModel.id);
        expect(JSON.stringify(bodies[1])).toContain(image.id);
        expect(JSON.stringify(bodies[1])).toContain("ZK-427");
        expect(JSON.stringify(bodies[1])).not.toContain("CURRENT MEMORY SYN-981");
        expect(JSON.stringify(bodies[1])).toContain(
            "cross-conversation history disabled"
        );
        expect(JSON.stringify(bodies[1]?.messages)).not.toContain('"type":"image_url"');
    } finally {
        request.mockRestore();
        await provider.stop(true);
        await database.close();
        await rm(directory, { recursive: true, force: true });
    }
});
