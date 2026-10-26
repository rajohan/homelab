import { expect, spyOn, test } from "bun:test";
import { rejects } from "node:assert/strict";

import { capabilities } from "@homelab/contracts/operations";
import { publishGitHubBinding } from "@homelab/mira/data/github";
import { claimMiraRun } from "@homelab/mira/data/queue";
import { githubBindingHash } from "@homelab/mira/integrations/github/configuration";

import { createMiraTools } from "../../../../mira/src/server/executor/tools";
import { createGitHubReadTools } from "../../../../mira/src/server/integrations/github/readTools";
import { base, configuration } from "../../../../mira/src/server/testing/github";
import { githubReadProvider } from "../../../../mira/src/server/testing/githubRead";
import { appRouter } from "../api/router";
import { operationFixture } from "../testing/operations";

const signal = new AbortController().signal;
async function fixture() {
    const f = await operationFixture();
    const binding = { owner: configuration.owner };
    const context = {
        client: f.client,
        owner: binding.owner,
        actor: `human:${binding.owner}`,
    };
    await f.client`INSERT INTO mira_runtime_status(id,worker_id,version,ready,heartbeat_at,integrations) VALUES (1,${crypto.randomUUID()},'synthetic',true,now(),${JSON.stringify([{ owner: binding.owner, key: "github", bindingHash: githubBindingHash(binding), sendConfigured: true }])}::text::jsonb)`;
    await publishGitHubBinding(f.client, binding);
    const api = appRouter.createCaller({
        operations: { ...f, githubBinding: binding },
        principal: { kind: "human", id: binding.owner, capabilities },
    }).mira;
    const toggle = (enabled: boolean, version: number) =>
        api.controls.setEnabled({
            key: "integration:github",
            enabled,
            version,
            reason: enabled ? null : "Intentional pause",
            until: null,
        });
    await toggle(true, 1);
    const chat = await api.conversations.create({ title: "Inspect repository" });
    await api.conversations.send({
        conversationId: chat.id,
        requestId: crypto.randomUUID(),
        text: "Read existing work",
        attachmentIds: [],
    });
    const run = await claimMiraRun(f.client, crypto.randomUUID(), "foreground");
    if (!run) throw new Error("Expected synthetic claim.");
    const invoke = (
        provider: ReturnType<typeof githubReadProvider>,
        name = "mira_github_work",
        input: unknown = {}
    ) =>
        createGitHubReadTools(f.client, run, configuration, provider.request)
            .find((tool) => tool.name === name)!
            .action(input, signal, context);
    return { ...f, api, run, context, toggle, invoke };
}

test("GitHub model reads are bounded, receipt-fenced, credential-free and cannot publish", async () => {
    const f = await fixture(),
        provider = githubReadProvider();
    const mocked = spyOn(globalThis, "fetch").mockImplementation(provider.request);
    try {
        const tools = createMiraTools(
            f.client,
            f.run,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            configuration
        );
        expect(JSON.stringify(tools)).not.toContain(configuration.token);
        expect(
            tools
                .filter((tool) => tool.name.startsWith("mira_github_"))
                .map((tool) => tool.name)
        ).toEqual([
            "mira_github_work",
            "mira_github_pull_request",
            "mira_github_tree",
            "mira_github_file",
        ]);
        expect(
            tools.some((tool) => /github.*(publish|approve|merge|deploy)/.test(tool.name))
        ).toBe(false);
        const tool = tools.find((tool) => tool.name === "mira_github_work")!;
        const call = { callId: "read-once", threadId: "synthetic", turnId: "synthetic" };
        const result = await tool.execute({}, signal, call);
        expect(JSON.parse(result)).toMatchObject({
            ok: true,
            result: {
                trust: "untrusted_repository_content",
                data: { commit: base, rows: [{ number: 123 }] },
            },
        });
        expect(result).not.toContain(configuration.token);
        const count = provider.calls.length;
        expect(JSON.parse(await tool.execute({}, signal, call))).toMatchObject({
            ok: false,
        });
        expect(provider.calls).toHaveLength(count);
        for (const [name, input] of [
            ["mira_github_pull_request", { number: 123 }],
            ["mira_github_tree", { commit: base }],
            ["mira_github_file", { commit: base, path: "src/app.ts" }],
        ] as const) {
            expect(
                JSON.parse(
                    await tools
                        .find((item) => item.name === name)!
                        .execute(input, signal, { ...call, callId: name })
                )
            ).toMatchObject({ ok: true });
        }
        expect(provider.calls.every((call) => call.init.method === "GET")).toBe(true);
        const rows = await f.client<
            { state: string }[]
        >`SELECT state FROM mira_tool_receipts WHERE run_id=${f.run.id}`;
        expect(rows).toHaveLength(4);
        expect(rows.every((row) => row.state === "succeeded")).toBe(true);
        const proposals = await f.api.code.list({});
        expect(proposals.rows).toHaveLength(0);
    } finally {
        mocked.mockRestore();
        await f.close();
    }
});

for (const fault of [
    "paused",
    "stale-runtime",
    "stale-dashboard",
    "wrong-runtime",
    "wrong-dashboard",
    "wrong-control",
    "cancelled",
    "expired",
    "wrong-lease",
    "wrong-owner",
    "unconfigured",
] as const)
    test(`GitHub context denies ${fault} before requesting the provider`, async () => {
        const f = await fixture(),
            provider = githubReadProvider();
        try {
            if (fault === "paused") await f.toggle(false, 2);
            if (fault === "stale-runtime")
                await f.client`UPDATE mira_runtime_status SET heartbeat_at=now()-interval '2 minutes'`;
            if (fault === "stale-dashboard")
                await f.client`UPDATE mira_integration_receivers SET heartbeat_at=now()-interval '2 minutes'`;
            if (fault === "wrong-runtime")
                await f.client`UPDATE mira_runtime_status SET integrations='[]'::jsonb`;
            if (fault === "wrong-dashboard")
                await publishGitHubBinding(f.client, { owner: "other" });
            if (fault === "wrong-control")
                await f.client`UPDATE mira_switches SET binding_hash='other' WHERE key='integration:github'`;
            if (fault === "cancelled")
                await f.client`UPDATE mira_runs SET cancel_requested=true WHERE id=${f.run.id}`;
            if (fault === "expired")
                await f.client`UPDATE mira_runs SET lease_expires_at=now()-interval '1 second' WHERE id=${f.run.id}`;
            if (fault === "wrong-lease") f.run.leaseToken = crypto.randomUUID();
            const config =
                fault === "wrong-owner"
                    ? { ...configuration, owner: "other" }
                    : configuration;
            const tools = createGitHubReadTools(
                f.client,
                f.run,
                fault === "unconfigured" ? undefined : config,
                provider.request
            );
            await rejects(
                tools[0]!.action({}, signal, f.context),
                /not configured|no longer has access/
            );
            expect(provider.calls).toHaveLength(0);
        } finally {
            await f.close();
        }
    });

for (const stage of ["between", "after", "resumed", "cancelled"] as const)
    test(`GitHub reads withhold results when access changes ${stage}`, async () => {
        const f = await fixture();
        let count = 0;
        const provider = githubReadProvider(async (_url, _init, reply) => {
            const response = reply();
            count++;
            if (count === (stage === "after" ? 5 : 1)) {
                if (stage === "cancelled")
                    await f.client`UPDATE mira_runs SET cancel_requested=true WHERE id=${f.run.id}`;
                else {
                    await f.toggle(false, 2);
                    if (stage === "resumed") await f.toggle(true, 3);
                }
            }
            return response;
        });
        try {
            await rejects(f.invoke(provider), /no longer has access/);
            expect(provider.calls).toHaveLength(stage === "after" ? 5 : 1);
        } finally {
            await f.close();
        }
    });

test("GitHub provider failures are sanitized known read failures and do not poison later calls", async () => {
    const f = await fixture();
    let failed = false;
    const provider = githubReadProvider((_url, _init, reply) => {
        if (!failed) {
            failed = true;
            throw new Error(configuration.token);
        }
        return reply();
    });
    const mocked = spyOn(globalThis, "fetch").mockImplementation(provider.request);
    try {
        const tools = createMiraTools(
            f.client,
            f.run,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            configuration
        );
        const tool = tools.find((tool) => tool.name === "mira_github_work")!;
        const call = { callId: "failed", threadId: "synthetic", turnId: "synthetic" };
        const result = await tool.execute({}, signal, call);
        expect(JSON.parse(result)).toMatchObject({ ok: false, retryable: true });
        expect(result).not.toContain(configuration.token);
        expect(
            JSON.parse(await tool.execute({}, signal, { ...call, callId: "retry-read" }))
        ).toMatchObject({ ok: true });
    } finally {
        mocked.mockRestore();
        await f.close();
    }
});

test("automatic GitHub reads honor individual pause and preserve explicit Run now semantics", async () => {
    const f = await fixture(),
        provider = githubReadProvider();
    try {
        const automation = await f.api.automations.create({
            title: "Inspect improvements",
            prompt: "Read only.",
            kind: "custom",
            schedule: { kind: "interval", intervalSeconds: 60 },
            budgetSeconds: 60,
        });
        await f.api.controls.setEnabled({
            key: `automation:${automation.id}`,
            enabled: true,
            version: 1,
            reason: null,
            until: null,
        });
        f.run.automationId = automation.id;
        f.run.manual = false;
        await f.client`UPDATE mira_runs SET automation_id=${automation.id},manual=false WHERE id=${f.run.id}`;
        const tools = createGitHubReadTools(
            f.client,
            f.run,
            configuration,
            provider.request
        );
        expect(tools.every((tool) => tool.automatic)).toBe(true);
        expect(await tools[0]!.action({}, signal, f.context)).toMatchObject({
            data: { commit: base },
        });
        await f.api.controls.setEnabled({
            key: `automation:${automation.id}`,
            enabled: false,
            version: 2,
            reason: "Away",
            until: null,
        });
        await rejects(tools[0]!.action({}, signal, f.context), /no longer has access/);
        f.run.manual = true;
        await f.client`UPDATE mira_runs SET manual=true WHERE id=${f.run.id}`;
        expect(await tools[0]!.action({}, signal, f.context)).toMatchObject({
            data: { commit: base },
        });
        await f.toggle(false, 2);
        await rejects(tools[0]!.action({}, signal, f.context), /no longer has access/);
    } finally {
        await f.close();
    }
});
