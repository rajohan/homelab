import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { capabilities } from "@homelab/contracts/operations";
import { publishDaytonaBinding } from "@homelab/mira/data/daytona";
import { saveMiraFile, deleteMiraFile } from "@homelab/mira/data/files";
import { publishGitHubBinding } from "@homelab/mira/data/github";
import { claimMiraRun } from "@homelab/mira/data/queue";
import {
    improvementJobAllowed,
    resolveImprovement,
    saveImprovementGrant,
} from "@homelab/mira/improvement/policy";
import { dispatchMiraImprovement } from "@homelab/mira/improvement/worker";
import { daytonaBindingHash } from "@homelab/mira/integrations/daytona/configuration";
import { dispatchMiraDaytona } from "@homelab/mira/integrations/daytona/jobs";
import { githubBindingHash } from "@homelab/mira/integrations/github/configuration";
import { dispatchMiraCode } from "@homelab/mira/integrations/github/outbox";

import { createMiraTools } from "../../../../mira/src/server/executor/tools";
import {
    base,
    configuration as github,
    githubProvider,
} from "../../../../mira/src/server/testing/github";
import { githubReadProvider } from "../../../../mira/src/server/testing/githubRead";
import { appRouter } from "../api/router";
import { operationFixture } from "../testing/operations";

const signal = new AbortController().signal;
const daytona = {
    owner: "operator",
    trustBoundary: "dedicated-organization" as const,
    networkAccess: "provider-default" as const,
    organizationId: "11111111-1111-4111-8111-111111111111",
    snapshotId: "22222222-2222-4222-8222-222222222222",
    target: "eu",
    apiKey: "synthetic-daytona-secret",
    executionQualified: true,
};
const bindings = { daytona, github };
const input = {
    commit: base,
    title: "fix(dashboard): improve layout",
    body: "Small frontend improvement. Fixed checks are recorded separately.",
    plan: {
        version: 1,
        commit: base,
        files: [
            {
                path: "apps/dashboard/src/browser/example.ts",
                beforeSha256: null,
                content: "export const example = 1;\n",
            },
        ],
    },
};

const provider = (id: string) =>
    githubProvider(id, (url, _init, reply) =>
        url.pathname.endsWith("/pulls") && url.searchParams.get("state") === "open"
            ? Response.json([])
            : reply()
    );

async function fixture() {
    const f = await operationFixture(),
        directory = await mkdtemp(path.join(tmpdir(), "mira-improvement-"));
    const context = {
        client: f.client,
        owner: github.owner,
        actor: `human:${github.owner}`,
    };
    const integrations = [
        {
            owner: github.owner,
            key: "daytona",
            bindingHash: daytonaBindingHash(daytona),
            sendConfigured: true,
        },
        {
            owner: github.owner,
            key: "github",
            bindingHash: githubBindingHash(github),
            sendConfigured: true,
        },
    ];
    await f.client`INSERT INTO mira_runtime_status(id,worker_id,version,ready,heartbeat_at,integrations) VALUES(1,${crypto.randomUUID()},'synthetic',true,now(),${JSON.stringify(integrations)}::text::jsonb)`;
    await publishDaytonaBinding(f.client, daytona);
    await publishGitHubBinding(f.client, github);
    const operations = {
        ...f,
        daytonaBinding: daytona,
        githubBinding: github,
        miraFilesDirectory: directory,
    };
    const api = appRouter.createCaller({
        operations,
        principal: { kind: "human", id: github.owner, capabilities },
    }).mira;
    const control = async (key: string, enabled: boolean) => {
        const rows = await api.controls.list(),
            current = rows.find((row) => row.key === key)!;
        await api.controls.setEnabled({
            key,
            enabled,
            version: current.version,
            reason: enabled ? null : "Intentional pause",
            until: null,
        });
    };
    await control("integration:daytona", true);
    await control("integration:github", true);
    const fields = {
        title: "Dashboard improvement",
        kind: "improvement" as const,
        prompt: "Inspect and improve one frontend issue.",
        schedule: { kind: "interval" as const, intervalSeconds: 60 },
        budgetSeconds: 900,
        delivery: "reports" as const,
    };
    const automation = await api.automations.create(fields);
    await control(`automation:${automation.id}`, true);
    const grant = (enabled: boolean, version = 0) =>
        api.improvements.allow({
            automationId: automation.id,
            automationVersion: 1,
            version,
            enabled,
            policyVersion: 1,
        });
    const start = async () => {
        await api.automations.run({ id: automation.id, requestId: crypto.randomUUID() });
        const run = await claimMiraRun(f.client, crypto.randomUUID(), "foreground");
        if (!run) throw new Error("Expected synthetic run.");
        const tools = createMiraTools(
            f.client,
            run,
            directory,
            undefined,
            undefined,
            undefined,
            daytona,
            github
        );
        const submit = async (
            proposal: unknown = input,
            callId = crypto.randomUUID()
        ) => {
            const raw = await tools
                .find((tool) => tool.name === "mira_improvement_submit")!
                .execute(proposal, signal, {
                    callId,
                    threadId: "synthetic",
                    turnId: "synthetic",
                });
            return JSON.parse(raw) as {
                ok: boolean;
                message?: string;
                result?: { id: string; state: string };
            };
        };
        return { run, tools, submit };
    };
    const dispatch = (request: typeof fetch) =>
        dispatchMiraImprovement(f.client, bindings, signal, directory, request);
    const completed = async (id: string) => {
        await f.client`UPDATE mira_daytona_jobs SET state='completed',phase='closed',cleanup='confirmed',outcome='completed',exit_code=0 WHERE id=${id}`;
    };
    const state = async (id: string) => {
        const [row] = await f.client<
            { state: string; reportId: string | null }[]
        >`SELECT state,report_id AS "reportId" FROM mira_improvements WHERE id=${id}`;
        return row!;
    };
    return {
        ...f,
        context,
        operations,
        api,
        automation,
        fields,
        grant,
        control,
        start,
        provider,
        dispatch,
        completed,
        state,
        directory,
        close: async () => {
            await f.close();
            await rm(directory, { recursive: true, force: true });
        },
    };
}

test("automatic frontend work continues after the model turn and publishes one verified draft with a report", async () => {
    const f = await fixture();
    try {
        expect(await f.api.improvements.grant({ id: f.automation.id })).toMatchObject({
            enabled: false,
            current: false,
            available: true,
            version: 0,
        });
        await f.grant(true);
        const { run, submit } = await f.start(),
            submitted = await submit();
        expect(submitted.ok).toBe(true);
        const id = submitted.result!.id,
            provider = f.provider(id);
        expect(await submit()).toMatchObject({
            ok: true,
            result: { id, state: "queued" },
        });
        expect(await submit({ ...input, title: "fix: different" })).toMatchObject({
            ok: false,
        });
        await f.client`UPDATE mira_runs SET state='completed' WHERE id=${run.id}`;
        expect(await f.dispatch(provider.request)).toBe(true);
        expect(await f.state(id)).toMatchObject({ state: "checking" });
        const job = await f.api.daytona.read({ id });
        expect(job).toMatchObject({
            state: "queued",
            conversationId: run.conversationId,
            content: { outputs: ["check-result.json", "check-log.txt", "changes.txt"] },
        });
        expect(job.content.command).toContain(
            `/opt/homelab/daytona-check.js ${id} ${base} --edits `
        );
        expect(await improvementJobAllowed(f.client, id, "cloud")).toBe(true);
        expect(provider.calls.every((call) => call.init.method === "GET")).toBe(true);
        await f.completed(id);
        await f.dispatch(provider.request);
        expect(await f.state(id)).toMatchObject({ state: "publishing" });
        expect(await f.api.code.read({ id })).toMatchObject({
            state: "queued",
            content: { title: input.title },
        });
        expect(
            await dispatchMiraCode(
                f.client,
                github,
                signal,
                f.directory,
                provider.request
            )
        ).toBe(true);
        await f.dispatch(provider.request);
        const final = await f.state(id);
        expect(final.state).toBe("published");
        expect(final.reportId).not.toBeNull();
        expect(await f.api.code.read({ id })).toMatchObject({
            state: "published",
            number: 123,
        });
        const count = provider.calls.length;
        expect(await f.dispatch(provider.request)).toBe(false);
        expect(provider.calls).toHaveLength(count);
        const reports = await f.api.reports.list({ search: "", archived: false });
        expect(reports.rows).toHaveLength(1);
        expect(reports.rows[0]!.markdown).toContain("No merge or deployment");
        expect(reports.rows[0]!.runId).toBe(run.id);
        const notices = await f.client<
            { recipient: string; destination: string; severity: string }[]
        >`SELECT recipient,destination,severity FROM dashboard_notifications WHERE source='mira' AND source_key=${`improvement:${id}`}`;
        expect(notices).toEqual([
            {
                recipient: `human:${github.owner}`,
                destination: "reports",
                severity: "info",
            },
        ]);
    } finally {
        await f.close();
    }
});

test("coding grant is human-only, owner-scoped, versioned and invalidated by definition edits", async () => {
    const f = await fixture();
    try {
        const { run, submit } = await f.start();
        expect(await submit()).toMatchObject({ ok: false });
        await rejects(
            saveImprovementGrant(
                {
                    ...f.context,
                    actor: "mira",
                    run: { id: run.id, leaseToken: run.leaseToken },
                },
                {
                    automationId: f.automation.id,
                    automationVersion: 1,
                    version: 0,
                    enabled: true,
                    policyVersion: 1,
                },
                bindings
            ),
            /Only the operator/
        );
        const other = appRouter.createCaller({
            operations: f.operations,
            principal: { kind: "human", id: "other", capabilities },
        }).mira;
        await rejects(other.improvements.grant({ id: f.automation.id }));
        await f.grant(true);
        await rejects(f.grant(true));
        await f.api.automations.update({
            ...f.fields,
            id: f.automation.id,
            version: 1,
            prompt: "Changed instructions",
        });
        expect(await f.api.improvements.grant({ id: f.automation.id })).toMatchObject({
            enabled: true,
            current: false,
        });
        expect(await submit()).toMatchObject({ ok: false });
        await rejects(f.grant(false, 1), /automation changed/);
        await f.api.improvements.allow({
            automationId: f.automation.id,
            automationVersion: 2,
            version: 1,
            enabled: false,
            policyVersion: 1,
        });
    } finally {
        await f.close();
    }
});

for (const fault of [
    "grant",
    "automation",
    "autonomy",
    "daytona",
    "github",
    "definition",
    "run-cancelled",
    "snapshot",
    "expired",
] as const)
    test(`automatic coding denies ${fault} changes before spending and after pause/resume`, async () => {
        const f = await fixture();
        try {
            await f.grant(true);
            const { run, submit } = await f.start(),
                submitted = await submit(),
                id = submitted.result!.id;
            if (fault === "grant") {
                await f.grant(false, 1);
                await f.grant(true, 2);
            }
            if (fault === "automation") {
                await f.control(`automation:${f.automation.id}`, false);
                await f.control(`automation:${f.automation.id}`, true);
            }
            if (fault === "autonomy") {
                await f.control("autonomy", false);
                await f.control("autonomy", true);
            }
            if (fault === "daytona") {
                await f.control("integration:daytona", false);
                await f.control("integration:daytona", true);
            }
            if (fault === "github") {
                await f.control("integration:github", false);
                await f.control("integration:github", true);
            }
            if (fault === "definition")
                await f.api.automations.update({
                    ...f.fields,
                    id: f.automation.id,
                    version: 1,
                });
            if (fault === "run-cancelled")
                await f.client`UPDATE mira_runs SET cancel_requested=true WHERE id=${run.id}`;
            if (fault === "snapshot")
                await publishDaytonaBinding(f.client, {
                    ...daytona,
                    snapshotId: crypto.randomUUID(),
                });
            if (fault === "expired")
                await f.client`UPDATE mira_improvements SET created_at=now()-interval '2 hours' WHERE id=${id}`;
            const provider = f.provider(id);
            await f.dispatch(provider.request);
            expect(provider.calls).toHaveLength(0);
            expect(await f.state(id)).toMatchObject({ state: "cancelled" });
            await rejects(f.api.daytona.read({ id }));
            expect(
                await f.client`SELECT id FROM dashboard_notifications WHERE source_key=${`improvement:${id}`}`
            ).toHaveLength(0);
        } finally {
            await f.close();
        }
    });

test("pausing during GitHub preflight prevents later requests and cloud admission", async () => {
    const f = await fixture();
    try {
        await f.grant(true);
        const { submit } = await f.start(),
            submitted = await submit(),
            id = submitted.result!.id;
        let count = 0;
        const provider = githubProvider(id, async (_url, _init, reply) => {
            count++;
            await f.grant(false, 1);
            return reply();
        });
        await f.dispatch(provider.request);
        expect(count).toBe(1);
        expect(await f.state(id)).toMatchObject({ state: "failed" });
        await rejects(f.api.daytona.read({ id }));
    } finally {
        await f.close();
    }
});

test("an existing Mira PR blocks automatic cloud work", async () => {
    const f = await fixture();
    try {
        await f.grant(true);
        const { submit } = await f.start(),
            submitted = await submit(),
            id = submitted.result!.id;
        const provider = githubReadProvider();
        await f.dispatch(provider.request);
        expect(await f.state(id)).toMatchObject({ state: "failed" });
        await rejects(f.api.daytona.read({ id }));
    } finally {
        await f.close();
    }
});

for (const failure of [
    "check-failed",
    "cleanup",
    "payload",
    "revoke-cloud",
    "revoke-publish",
    "new-pr",
] as const)
    test(`automatic work never publishes after ${failure}`, async () => {
        const f = await fixture();
        try {
            await f.grant(true);
            const { submit } = await f.start(),
                submitted = await submit(),
                id = submitted.result!.id,
                provider = f.provider(id);
            await f.dispatch(provider.request);
            await f.completed(id);
            if (failure === "check-failed")
                await f.client`UPDATE mira_daytona_jobs SET state='failed',outcome='failed',exit_code=1 WHERE id=${id}`;
            if (failure === "cleanup")
                await f.client`UPDATE mira_daytona_jobs SET cleanup='not_needed' WHERE id=${id}`;
            if (failure === "payload")
                await f.client`UPDATE mira_daytona_jobs SET content_hash='changed' WHERE id=${id}`;
            if (failure === "revoke-cloud") {
                await f.client`UPDATE mira_daytona_jobs SET state='queued',cleanup='not_needed',phase='draft' WHERE id=${id}`;
                await f.grant(false, 1);
                expect(
                    await dispatchMiraDaytona(
                        f.client,
                        daytona,
                        signal,
                        f.directory,
                        provider.request
                    )
                ).toBe(false);
            }
            await f.dispatch(
                failure === "new-pr" ? githubReadProvider().request : provider.request
            );
            if (failure === "revoke-publish") {
                expect(await f.state(id)).toMatchObject({ state: "publishing" });
                await f.grant(false, 1);
                expect(
                    await dispatchMiraCode(
                        f.client,
                        github,
                        signal,
                        f.directory,
                        provider.request
                    )
                ).toBe(false);
                await f.dispatch(provider.request);
            }
            expect(provider.calls.some((call) => call.init.method === "POST")).toBe(
                false
            );
            const result = await f.state(id);
            expect(["failed", "cancelled"]).toContain(result.state);
        } finally {
            await f.close();
        }
    });

test("workflow admission serializes concurrent runs and enforces the rolling daily limit", async () => {
    const f = await fixture();
    try {
        await f.grant(true);
        const first = await f.start();
        const results = await Promise.all([first.submit(), first.submit()]);
        expect(results.every((result) => result.ok)).toBe(true);
        expect(results[0].result!.id).toBe(results[1].result!.id);
        await f.client`UPDATE mira_runs SET state='completed' WHERE id=${first.run.id}`;
        const second = await f.start();
        expect(await second.submit()).toMatchObject({ ok: false });
        await f.client`UPDATE mira_improvements SET state='failed'`;
        expect(await second.submit()).toMatchObject({ ok: true });
        await f.client`UPDATE mira_improvements SET state='failed'`;
        await f.client`UPDATE mira_runs SET state='completed' WHERE id=${second.run.id}`;
        const third = await f.start();
        expect(await third.submit()).toMatchObject({ ok: false });
    } finally {
        await f.close();
    }
});

test("conversation deletion waits for automatic work and later scrubs its proposal", async () => {
    const f = await fixture();
    try {
        await f.grant(true);
        const { run, submit } = await f.start(),
            submitted = await submit(),
            id = submitted.result!.id;
        await f.client`UPDATE mira_runs SET state='completed' WHERE id=${run.id}`;
        const [conversation] = await f.client<
            { version: number }[]
        >`SELECT version FROM mira_conversations WHERE id=${run.conversationId}`;
        await rejects(
            f.api.conversations.change({
                id: run.conversationId,
                version: conversation!.version,
                action: "delete",
            }),
            /automatic code/
        );
        await f.grant(false, 1);
        await f.dispatch(f.provider(id).request);
        await f.api.conversations.change({
            id: run.conversationId,
            version: conversation!.version,
            action: "delete",
        });
        const [row] = await f.client<
            { content: unknown; hash: string }[]
        >`SELECT content,content_hash AS hash FROM mira_improvements WHERE id=${id}`;
        expect(row).toEqual({ content: {}, hash: "" });
    } finally {
        await f.close();
    }
});

test("renewed permission cannot upgrade an already running automation", async () => {
    const f = await fixture();
    try {
        const { submit } = await f.start();
        await f.grant(true);
        expect(await submit()).toMatchObject({ ok: false });
        expect(await f.client`SELECT id FROM mira_improvements`).toHaveLength(0);
    } finally {
        await f.close();
    }
});

test("improvement runs cannot read private memory even with a coding grant", async () => {
    const f = await fixture();
    try {
        await f.grant(true);
        const { tools } = await f.start();
        const result = await tools
            .find((tool) => tool.name === "mira_memory_list")!
            .execute({}, signal, {
                callId: crypto.randomUUID(),
                threadId: "synthetic",
                turnId: "synthetic",
            });
        const denied = JSON.parse(result) as { ok: boolean; message: string };
        expect(denied.ok).toBe(false);
        expect(denied.message).toContain("Private inbox");
        expect(await f.client`SELECT id FROM mira_tool_receipts`).toHaveLength(0);
    } finally {
        await f.close();
    }
});

test("blocked automatic work requires human review, settled cleanup and a fresh GitHub observation", async () => {
    const f = await fixture();
    try {
        await f.grant(true);
        const { run, submit } = await f.start(),
            submitted = await submit(),
            id = submitted.result!.id,
            provider = f.provider(id);
        await f.dispatch(provider.request);
        await f.completed(id);
        await f.dispatch(provider.request);
        await f.client`UPDATE mira_code_publications SET state='needs_attention',message='Synthetic uncertain outcome' WHERE id=${id}`;
        await f.dispatch(provider.request);
        expect(await f.state(id)).toMatchObject({ state: "needs_attention" });
        const warnings = await f.client<
            { severity: string; recipient: string }[]
        >`SELECT severity,recipient FROM dashboard_notifications WHERE source_key=${`improvement:${id}`}`;
        expect(warnings).toEqual([
            { severity: "warning", recipient: `human:${github.owner}` },
        ]);
        const review = {
            id,
            reviewed: true as const,
            reason: "Confirmed the recorded provider outcome.",
        };
        await rejects(
            resolveImprovement(
                {
                    ...f.context,
                    actor: "mira",
                    run: { id: run.id, leaseToken: run.leaseToken },
                },
                review
            ),
            /Only the operator/
        );
        const other = appRouter.createCaller({
            operations: f.operations,
            principal: { kind: "human", id: "other", capabilities },
        }).mira;
        await rejects(other.improvements.resolve(review));
        await rejects(
            f.api.improvements.resolve({ ...review, reviewed: false as never })
        );
        const blocked = await f.api.improvements.grant({ id: f.automation.id });
        expect(blocked.blocked).toMatchObject({ id, canClose: false });
        expect(blocked.blocked!.reason).toContain("Inspect GitHub");
        await rejects(f.api.improvements.resolve(review));
        await f.client`UPDATE mira_code_publications SET observed_at=now()-interval '16 minutes' WHERE id=${id}`;
        await rejects(f.api.improvements.resolve(review));
        await f.client`UPDATE mira_code_publications SET observed_at=now() WHERE id=${id}`;
        await f.client`UPDATE mira_daytona_jobs SET cleanup='pending' WHERE id=${id}`;
        await rejects(f.api.improvements.resolve(review), /cleanup/);
        await f.client`UPDATE mira_daytona_jobs SET cleanup='confirmed' WHERE id=${id}`;
        const ready = await f.api.improvements.grant({ id: f.automation.id });
        expect(ready.blocked).toMatchObject({ id, canClose: true });
        const calls = provider.calls.length;
        await f.api.improvements.resolve(review);
        expect(await f.state(id)).toMatchObject({ state: "cancelled" });
        const closed = await f.api.improvements.grant({ id: f.automation.id });
        expect(closed.blocked).toBeNull();
        expect(await f.api.code.read({ id })).toMatchObject({ state: "needs_attention" });
        expect(await f.dispatch(provider.request)).toBe(false);
        expect(provider.calls).toHaveLength(calls);
        await rejects(f.api.improvements.resolve(review));
    } finally {
        await f.close();
    }
});

test("automatic coding rejects missing-file deletion before admission or spending", async () => {
    const f = await fixture();
    try {
        await f.grant(true);
        const { submit } = await f.start();
        expect(
            await submit({
                ...input,
                plan: {
                    ...input.plan,
                    files: [{ ...input.plan.files[0]!, content: null }],
                },
            })
        ).toMatchObject({ ok: false });
        expect(await f.client`SELECT id FROM mira_improvements`).toHaveLength(0);
        expect(await f.client`SELECT id FROM mira_daytona_jobs`).toHaveLength(0);
    } finally {
        await f.close();
    }
});

test("the originating improvement tool restriction survives automation kind edits", async () => {
    const f = await fixture();
    try {
        await f.grant(true);
        const { run, tools, submit } = await f.start();
        await f.api.automations.update({
            ...f.fields,
            id: f.automation.id,
            version: 1,
            kind: "custom",
        });
        const raw = await tools
            .find((tool) => tool.name === "mira_memory_list")!
            .execute({}, signal, {
                callId: crypto.randomUUID(),
                threadId: "synthetic",
                turnId: "synthetic",
            });
        expect(JSON.parse(raw)).toMatchObject({ ok: false });
        expect(await submit()).toMatchObject({ ok: false });
        const [stamp] = await f.client<
            { kind: string }[]
        >`SELECT automation_kind AS kind FROM mira_runs WHERE id=${run.id}`;
        expect(stamp!.kind).toBe("improvement");
    } finally {
        await f.close();
    }
});

test("active and unresolved improvements protect automation deletion and generated edit files across phase gaps", async () => {
    const f = await fixture();
    try {
        await f.grant(true);
        const { run, submit } = await f.start(),
            submitted = await submit(),
            id = submitted.result!.id;
        await f.client`UPDATE mira_runs SET state='completed' WHERE id=${run.id}`;
        await saveMiraFile(f.context, f.directory, {
            id,
            name: "improvement-edits.json",
            bytes: Buffer.from(JSON.stringify(input.plan)),
        });
        const [conversation] = await f.client<
            { version: number }[]
        >`SELECT version FROM mira_conversations WHERE id=${run.conversationId}`;
        for (const state of ["queued", "checking", "publishing", "needs_attention"]) {
            await f.client`UPDATE mira_improvements SET state=${state} WHERE id=${id}`;
            await rejects(
                f.api.automations.delete({ id: f.automation.id, version: 1 }),
                /Finish or review automatic code/
            );
            await rejects(
                f.api.automations.update({
                    ...f.fields,
                    id: f.automation.id,
                    version: 1,
                    kind: "custom",
                }),
                /Finish or review automatic code/
            );
            await rejects(
                f.api.conversations.change({
                    id: run.conversationId,
                    version: conversation!.version,
                    action: "delete",
                }),
                /Finish or review automatic code/
            );
            await rejects(
                deleteMiraFile(f.context, f.directory, id),
                /Finish or review automatic code/
            );
        }
        expect(await f.api.improvements.grant({ id: f.automation.id })).toMatchObject({
            blocked: { id, canClose: true },
        });
        await f.api.improvements.resolve({
            id,
            reviewed: true,
            reason: "Reviewed synthetic interrupted attempt; no external work exists.",
        });
        await deleteMiraFile(f.context, f.directory, id);
        await f.api.automations.delete({ id: f.automation.id, version: 1 });
    } finally {
        await f.close();
    }
});

test("silent automation delivery retains durable outcome reports without a notification", async () => {
    const f = await fixture();
    try {
        await f.api.automations.update({
            ...f.fields,
            id: f.automation.id,
            version: 1,
            delivery: "silent",
        });
        await f.api.improvements.allow({
            automationId: f.automation.id,
            automationVersion: 2,
            version: 0,
            enabled: true,
            policyVersion: 1,
        });
        const { submit } = await f.start(),
            result = await submit(),
            id = result.result!.id;
        await f.dispatch(githubReadProvider().request);
        expect(await f.state(id)).toMatchObject({ state: "failed" });
        expect(
            await f.client`SELECT id FROM mira_reports WHERE run_id=(SELECT run_id FROM mira_improvements WHERE id=${id})`
        ).toHaveLength(1);
        expect(
            await f.client`SELECT id FROM dashboard_notifications WHERE source_key=${`improvement:${id}`}`
        ).toHaveLength(0);
    } finally {
        await f.close();
    }
});
