import { expect, test, spyOn } from "bun:test";
import { rejects } from "node:assert/strict";

import { capabilities } from "@homelab/contracts/operations";
import { reconcileMiraControls } from "@homelab/mira/data/automations";
import {
    publishMoltbookBinding,
    moltbookBindingCurrent,
} from "@homelab/mira/data/moltbook";
import { claimMiraRun } from "@homelab/mira/data/queue";
import {
    moltbookBindingHash,
    type MoltbookBinding,
} from "@homelab/mira/integrations/moltbook/configuration";
import { MoltbookReader } from "@homelab/mira/integrations/moltbook/reader";
import type { SQL } from "bun";

import { createMiraTools } from "../../../../mira/src/server/executor/tools";
import { appRouter } from "../api/router";
import { parseOperationsConfiguration } from "../config/operations";
import { agentMailReceiverHeartbeat } from "../mira/agentmail";
import { operationFixture } from "../testing/operations";

const binding = { owner: "operator", agentName: "Mira" };
const configuration = { ...binding, apiKey: "synthetic-provider-key" };
async function provision(client: SQL, current: MoltbookBinding = binding) {
    await client`INSERT INTO mira_runtime_status(id,worker_id,version,ready,heartbeat_at,integrations) VALUES (1,${crypto.randomUUID()},'synthetic',true,now(),${JSON.stringify([{ owner: current.owner, key: "moltbook", bindingHash: moltbookBindingHash(current) }])}::text::jsonb) ON CONFLICT(id) DO UPDATE SET integrations=EXCLUDED.integrations,heartbeat_at=now()`;
    await publishMoltbookBinding(client, current);
}
async function fixture() {
    const f = await operationFixture();
    await provision(f.client);
    const api = appRouter.createCaller({
        operations: { ...f, moltbookBinding: binding },
        principal: { kind: "human", id: binding.owner, capabilities },
    }).mira;
    return { ...f, api };
}
const enabled = (version = 1) => ({
    key: "integration:moltbook",
    version,
    enabled: true,
    reason: null,
    until: null,
});
async function run(f: Awaited<ReturnType<typeof fixture>>) {
    const chat = await f.api.conversations.create({ title: "Read Moltbook" });
    await f.api.conversations.send({
        conversationId: chat.id,
        requestId: crypto.randomUUID(),
        text: "Read the configured feed",
    });
    const claimed = await claimMiraRun(f.client, crypto.randomUUID(), "foreground");
    expect(claimed).not.toBeNull();
    return claimed!;
}
function result(text: string) {
    return JSON.parse(text) as {
        ok: boolean;
        retryable?: boolean;
        message?: string;
        result?: { data: unknown; trust: string };
    };
}

test("Moltbook readiness is owner-scoped and requires fresh matching dashboard and runtime bindings", async () => {
    const f = await fixture();
    try {
        const statuses = await f.api.integrations();
        expect(statuses.find((x) => x.key === "integration:moltbook")).toMatchObject({
            configured: true,
            ready: true,
        });
        const other = appRouter.createCaller({
            operations: { ...f, moltbookBinding: binding },
            principal: { kind: "human", id: "other", capabilities },
        }).mira;
        const hidden = await other.integrations();
        expect(hidden.find((x) => x.key === "integration:moltbook")).toMatchObject({
            configured: false,
            ready: false,
            message: null,
        });
        await rejects(other.controls.setEnabled(enabled()), /configured/);
        await f.client`UPDATE mira_runtime_status SET heartbeat_at=now()-interval '1 minute'`;
        await rejects(f.api.controls.setEnabled(enabled()), /configured/);
        await provision(f.client, { ...binding, agentName: "Replacement" });
        await rejects(f.api.controls.setEnabled(enabled()), /same Moltbook/);
        await provision(f.client);
        await f.api.controls.setEnabled(enabled());
        const [control] = await f.client<
            { hash: string }[]
        >`SELECT binding_hash AS hash FROM mira_switches WHERE key='integration:moltbook'`;
        expect(control?.hash).toBe(moltbookBindingHash(binding));
    } finally {
        await f.close();
    }
});

test("Moltbook tools use durable receipts and read-only failures do not fence unrelated work", async () => {
    const f = await fixture();
    const profile = spyOn(MoltbookReader.prototype, "profile").mockRejectedValue(
        new Error("private provider diagnostics")
    );
    try {
        await f.api.controls.setEnabled(enabled());
        const claimed = await run(f);
        const tools = createMiraTools(
            f.client,
            claimed,
            undefined,
            undefined,
            configuration
        );
        const tool = tools.find((x) => x.name === "mira_moltbook_profile")!;
        const invoke = (callId: string) =>
            tool.execute({}, new AbortController().signal, {
                callId,
                threadId: "synthetic",
                turnId: "synthetic",
            });
        const failed = result(await invoke("failed-read"));
        expect(failed).toMatchObject({ ok: false, retryable: true });
        expect(failed.message).not.toContain("private provider");
        profile.mockResolvedValue({
            name: "Mira",
            description: "Passive text",
            karma: null,
            posts: null,
            comments: null,
            claimed: true,
        });
        const success = result(await invoke("retry-read"));
        expect(success).toMatchObject({
            ok: true,
            result: { trust: "untrusted_social_content", data: { name: "Mira" } },
        });
        const calls = profile.mock.calls.length;
        expect(result(await invoke("retry-read")).ok).toBe(false);
        expect(profile.mock.calls).toHaveLength(calls);
        const controls = tools.find((x) => x.name === "mira_controls_list")!;
        expect(
            result(
                await controls.execute({}, new AbortController().signal, {
                    callId: "controls",
                    threadId: "synthetic",
                    turnId: "synthetic",
                })
            ).ok
        ).toBe(true);
        const receipts = await f.client<
            { state: string }[]
        >`SELECT state FROM mira_tool_receipts WHERE run_id=${claimed.id} ORDER BY created_at,id`;
        expect(receipts.map((x) => x.state)).toContain("failed");
        expect(receipts.map((x) => x.state)).not.toContain("unknown");
    } finally {
        profile.mockRestore();
        await f.close();
    }
});

for (const change of ["pause", "regrant", "receiver", "lease", "cancel"] as const)
    test(`Moltbook discards content after ${change} during a provider read`, async () => {
        const f = await fixture();
        const started = Promise.withResolvers<void>();
        const finish = Promise.withResolvers<void>();
        const profile = spyOn(MoltbookReader.prototype, "profile").mockImplementation(
            async () => {
                started.resolve();
                await finish.promise;
                return {
                    name: "Mira",
                    description: "must-not-be-returned",
                    karma: null,
                    posts: null,
                    comments: null,
                    claimed: true,
                };
            }
        );
        try {
            await f.api.controls.setEnabled(enabled());
            const claimed = await run(f);
            const tool = createMiraTools(
                f.client,
                claimed,
                undefined,
                undefined,
                configuration
            ).find((x) => x.name === "mira_moltbook_profile")!;
            const pending = tool.execute({}, new AbortController().signal, {
                callId: "read",
                threadId: "synthetic",
                turnId: "synthetic",
            });
            await started.promise;
            if (change === "pause" || change === "regrant") {
                await f.api.controls.setEnabled({
                    ...enabled(2),
                    enabled: false,
                    reason: "Intentional pause",
                });
                if (change === "regrant") await f.api.controls.setEnabled(enabled(3));
            } else if (change === "receiver")
                await publishMoltbookBinding(f.client, {
                    ...binding,
                    agentName: "Other",
                });
            else if (change === "lease")
                await f.client`UPDATE mira_runs SET lease_expires_at=now()-interval '1 second' WHERE id=${claimed.id}`;
            else
                await f.client`UPDATE mira_runs SET cancel_requested=true WHERE id=${claimed.id}`;
            finish.resolve();
            const response = await pending;
            expect(result(response).ok).toBe(false);
            expect(response).not.toContain("must-not-be-returned");
        } finally {
            finish.resolve();
            profile.mockRestore();
            await f.close();
        }
    });

test("Moltbook pause blocks fresh reads and timed resume cannot adopt a replacement account", async () => {
    const f = await fixture();
    const profile = spyOn(MoltbookReader.prototype, "profile").mockRejectedValue(
        new Error("Must not call provider")
    );
    try {
        await f.api.controls.setEnabled(enabled());
        const claimed = await run(f);
        await f.api.controls.setEnabled({
            ...enabled(2),
            enabled: false,
            reason: "Away",
            until: new Date(Date.now() + 60_000).toISOString(),
        });
        const tool = createMiraTools(
            f.client,
            claimed,
            undefined,
            undefined,
            configuration
        ).find((x) => x.name === "mira_moltbook_profile")!;
        expect(
            result(
                await tool.execute({}, new AbortController().signal, {
                    callId: "paused",
                    threadId: "synthetic",
                    turnId: "synthetic",
                })
            ).ok
        ).toBe(false);
        expect(profile).not.toHaveBeenCalled();
        await f.client`UPDATE mira_switches SET until=now()-interval '1 second' WHERE key='integration:moltbook'`;
        await provision(f.client, { ...binding, agentName: "Replacement" });
        await reconcileMiraControls(f.client);
        const pausedControls = await f.api.controls.list();
        expect(
            pausedControls.find((x) => x.key === "integration:moltbook")
        ).toMatchObject({ enabled: false, reason: "Away" });
        await provision(f.client);
        await reconcileMiraControls(f.client);
        const resumedControls = await f.api.controls.list();
        expect(
            resumedControls.find((x) => x.key === "integration:moltbook")
        ).toMatchObject({ enabled: true, reason: null });
    } finally {
        profile.mockRestore();
        await f.close();
    }
});

test("dashboard provisioning publishes Moltbook account removal and never needs its API credential", async () => {
    const f = await operationFixture();
    try {
        const parsed = parseOperationsConfiguration({
            HOMELAB_DASHBOARD_DATABASE_URL: f.url,
            HOMELAB_MIRA_MOLTBOOK_OWNER: binding.owner,
            HOMELAB_MIRA_MOLTBOOK_AGENT_NAME: binding.agentName,
        });
        expect(parsed?.moltbookBinding).toEqual(binding);
        const stop = agentMailReceiverHeartbeat({ ...f, moltbookBinding: binding });
        await stop();
        expect(await moltbookBindingCurrent(f.client, binding)).toBe(true);
        const stopRemoved = agentMailReceiverHeartbeat(f);
        await stopRemoved();
        expect(await moltbookBindingCurrent(f.client, binding)).toBe(false);
    } finally {
        await f.close();
    }
});
