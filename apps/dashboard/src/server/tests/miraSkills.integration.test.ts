import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";

import { capabilities } from "@homelab/contracts/operations";
import { readMiraControlPage, resumeMiraControls } from "@homelab/mira/data/automations";
import { claimMiraRun } from "@homelab/mira/data/queue";
import { miraSkillCatalogHash } from "@homelab/mira/skills/catalog";
import * as v from "valibot";

import { appRouter } from "../api/router";
import { createMiraTextTestTools as createMiraTools } from "../testing/miraTools";
import { operationFixture } from "../testing/operations";

const signal = new AbortController().signal;
async function fixture(kind?: "improvement") {
    const f = await operationFixture();
    const caller = (id = "operator") =>
        appRouter.createCaller({
            operations: f,
            principal: { kind: "human", id, capabilities },
        }).mira;
    const api = caller();
    const worker = crypto.randomUUID();
    await f.client`INSERT INTO mira_runtime_status(id,worker_id,version,ready,heartbeat_at,skill_catalog_hash,skill_catalog_worker_id) VALUES(1,${worker},'synthetic',true,now(),${miraSkillCatalogHash},${worker})`;
    const toggle = async (key: string, enabled: boolean, until: string | null = null) => {
        const controls = await api.controls.list();
        const control = controls.find((item) => item.key === key)!;
        await api.controls.setEnabled({
            key,
            enabled,
            version: control.version,
            reason: enabled ? null : "Intentional guidance pause",
            until,
        });
    };
    const fields = {
        title: "Synthetic improvement",
        kind: "improvement" as const,
        prompt: "Inspect frontend guidance.",
        schedule: { kind: "interval" as const, intervalSeconds: 60 },
        budgetSeconds: 900,
        delivery: "reports" as const,
    };
    const automation = kind ? await api.automations.create(fields) : null;
    if (automation) {
        await toggle(`automation:${automation.id}`, true);
        await api.automations.run({ id: automation.id, requestId: crypto.randomUUID() });
    } else {
        const chat = await api.conversations.create({ title: "Synthetic guidance" });
        await api.conversations.send({
            conversationId: chat.id,
            requestId: crypto.randomUUID(),
            text: "Read relevant guidance.",
            attachmentIds: [],
        });
    }
    const run = await claimMiraRun(f.client, crypto.randomUUID(), "foreground");
    if (!run) throw new Error("Expected synthetic run.");
    const tools = createMiraTools(f.client, run);
    const invoke = async (
        name: string,
        input: unknown = {},
        callId: string = crypto.randomUUID()
    ) =>
        v.parse(
            v.object({ ok: v.boolean(), result: v.optional(v.unknown()) }),
            JSON.parse(
                await tools
                    .find((tool) => tool.name === name)!
                    .execute(input, signal, {
                        callId,
                        threadId: "synthetic",
                        turnId: "synthetic",
                    })
            )
        );
    return { ...f, api, caller, toggle, run, tools, invoke, automation, fields };
}

test("skills are inspectable while paused, owner isolated, versioned and human controlled", async () => {
    const f = await fixture();
    try {
        const rows = await f.api.skills.list();
        expect(rows).toHaveLength(7);
        expect(rows.every((row) => !row.control.enabled)).toBe(true);
        const task = rows.find((row) => row.id === "task-tracking")!;
        const input = { id: task.id, packageHash: task.packageHash, file: "SKILL.md" };
        const document = await f.api.skills.read(input);
        expect(document.content).toContain("# Tasks and reports");
        await rejects(f.api.skills.read({ ...input, file: "../SKILL.md" }), /not found/);
        await rejects(
            f.api.skills.read({ ...input, packageHash: "0".repeat(64) }),
            /changed/
        );
        expect(await f.invoke("mira_skill_read", input)).toMatchObject({ ok: false });
        await f.toggle("skill:task-tracking", true);
        const currentSkills = await f.api.skills.list();
        const otherSkills = await f.caller("other").skills.list();
        const currentControls = await f.api.controls.list();
        expect(currentSkills.find((row) => row.id === task.id)?.control.enabled).toBe(
            true
        );
        expect(otherSkills.find((row) => row.id === task.id)?.control.enabled).toBe(
            false
        );
        expect(
            currentControls
                .filter((row) => row.key.startsWith("integration:"))
                .every((row) => !row.enabled)
        ).toBe(true);
        await rejects(
            f.api.controls.setEnabled({
                key: "skill:arbitrary",
                enabled: true,
                version: 1,
                reason: null,
                until: null,
            }),
            /Unknown control/
        );
        await rejects(
            f.api.controls.setEnabled({
                key: task.control.key,
                enabled: false,
                version: 1,
                reason: "Stale request",
                until: null,
            }),
            /changed/
        );
        const machine = appRouter.createCaller({
            operations: f,
            principal: { kind: "automation", id: "machine", capabilities },
        });
        await rejects(machine.mira.skills.list(), /signed-in operator/);
        await rejects(machine.mira.skills.read(input), /signed-in operator/);
    } finally {
        await f.close();
    }
});

test("loaded guidance rechecks pauses, package hashes and execution leases without granting tools", async () => {
    const f = await fixture();
    try {
        const listed = await f.invoke("mira_skills_list");
        expect(listed.ok).toBe(true);
        const currentSkills = await f.api.skills.list();
        const task = currentSkills.find((row) => row.id === "task-tracking")!;
        const input = { id: task.id, packageHash: task.packageHash };
        await f.toggle(task.control.key, true);
        const before = f.tools.map((tool) => tool.name);
        expect(await f.invoke("mira_skill_read", input, "once")).toMatchObject({
            ok: true,
            result: { id: task.id, packageHash: task.packageHash },
        });
        expect(await f.invoke("mira_skill_read", input, "once")).toMatchObject({
            ok: false,
        });
        expect(f.tools.map((tool) => tool.name)).toEqual(before);
        await f.toggle(
            task.control.key,
            false,
            new Date(Date.now() + 60_000).toISOString()
        );
        expect(await f.invoke("mira_skill_read", input)).toMatchObject({ ok: false });
        await f.client.begin((query) =>
            resumeMiraControls(query, new Date(Date.now() + 120_000), "operator")
        );
        expect(
            await f.invoke("mira_skill_read", { ...input, packageHash: "a".repeat(64) })
        ).toMatchObject({ ok: false });
        expect(await f.invoke("mira_skill_read", input)).toMatchObject({ ok: true });
        await f.client`UPDATE mira_runs SET lease_expires_at=now()-interval '1 second' WHERE id=${f.run.id}`;
        expect(await f.invoke("mira_skill_read", input)).toMatchObject({ ok: false });
        expect(await f.invoke("mira_skills_list")).toMatchObject({ ok: false });
    } finally {
        await f.close();
    }
});

test("improvement guidance uses the captured run kind after definition edits and fails closed for legacy runs", async () => {
    const f = await fixture("improvement");
    try {
        await f.toggle("skill:agentmail", true);
        await f.toggle("skill:frontend-improvement", true);
        await f.api.automations.update({
            ...f.fields,
            id: f.automation!.id,
            version: 1,
            kind: "brief",
        });
        const listed = await f.invoke("mira_skills_list");
        expect(listed.ok).toBe(true);
        expect(
            v
                .parse(
                    v.array(v.object({ repositoryContext: v.boolean() })),
                    listed.result
                )
                .every((row: { repositoryContext: boolean }) => row.repositoryContext)
        ).toBe(true);
        const packages = await f.api.skills.list();
        for (const id of ["agentmail", "frontend-improvement"] as const) {
            const skill = packages.find((row) => row.id === id)!;
            const result = await f.invoke("mira_skill_read", {
                id,
                packageHash: skill.packageHash,
            });
            expect(result.ok).toBe(id === "frontend-improvement");
        }
        expect(await f.invoke("mira_mail_list")).toMatchObject({ ok: false });
        await f.client`UPDATE mira_runs SET automation_kind=NULL WHERE id=${f.run.id}`;
        const legacy = await f.invoke("mira_skills_list");
        expect(
            v
                .parse(
                    v.array(v.object({ repositoryContext: v.boolean() })),
                    legacy.result
                )
                .every((row: { repositoryContext: boolean }) => row.repositoryContext)
        ).toBe(true);
    } finally {
        await f.close();
    }
});

test("skill activation and timed resume require a fresh receipt from the matching executor process", async () => {
    const f = await fixture();
    const skill = "skill:task-tracking";
    const compatibility = async () => {
        const rows = await f.api.skills.list();
        return rows[0]!.compatibility;
    };
    try {
        expect(await compatibility()).toBe("available");
        await f.client`UPDATE mira_runtime_status SET skill_catalog_hash=NULL`;
        expect(await compatibility()).toBe("update_required");
        await rejects(f.toggle(skill, true), /same skill catalog/);
        await f.client`UPDATE mira_runtime_status SET skill_catalog_hash=${miraSkillCatalogHash},worker_id=${crypto.randomUUID()}`;
        expect(await compatibility()).toBe("update_required");
        await rejects(f.toggle(skill, true), /same skill catalog/);
        await f.client`UPDATE mira_runtime_status SET skill_catalog_worker_id=worker_id,heartbeat_at=now()-interval '1 minute'`;
        expect(await compatibility()).toBe("offline");
        await rejects(f.toggle(skill, true), /same skill catalog/);
        await f.client`UPDATE mira_runtime_status SET heartbeat_at=now(),ready=false`;
        expect(await compatibility()).toBe("offline");
        await f.client`UPDATE mira_runtime_status SET ready=true`;
        await f.toggle(skill, true);
        await f.toggle(skill, false, new Date(Date.now() + 60_000).toISOString());
        const resumeTime = new Date(Date.now() + 120_000);
        // The parent executor selects expired controls exclusively through `until`.
        // Skills must be invisible to that unchanged rollback query.
        await f.toggle("autonomy", false, new Date(Date.now() + 60_000).toISOString());
        const legacy = await f.client<{ key: string }[]>`
            UPDATE mira_switches SET enabled=true,reason=NULL,changed_at=until,until=NULL,version=version+1
            WHERE owner='operator' AND NOT enabled AND until <= ${resumeTime} RETURNING key`;
        expect([...legacy]).toEqual([{ key: "autonomy" }]);
        const pausedPage = await readMiraControlPage({
            client: f.client,
            owner: "operator",
            actor: "operator",
        });
        expect(pausedPage.rows.find((row) => row.key === skill)?.until).not.toBeNull();
        await rejects(
            f.client`UPDATE mira_switches SET until=now() WHERE owner='operator' AND key=${skill}`,
            /mira_switches_skill_resume/
        );
        await f.client`UPDATE mira_runtime_status SET skill_catalog_hash='outdated'`;
        await f.client.begin((query) =>
            resumeMiraControls(query, new Date(Date.now() + 120_000), "operator")
        );
        const paused = await f.api.controls.list();
        expect(paused.find((row) => row.key === skill)?.enabled).toBe(false);
        await f.client`UPDATE mira_runtime_status SET skill_catalog_hash=${miraSkillCatalogHash}`;
        await f.client.begin((query) =>
            resumeMiraControls(query, new Date(Date.now() + 120_000), "operator")
        );
        const resumed = await f.api.controls.list();
        expect(resumed.find((row) => row.key === skill)?.enabled).toBe(true);
        await f.client`DELETE FROM mira_runtime_status`;
        expect(await compatibility()).toBe("offline");
    } finally {
        await f.close();
    }
});

test("skill pause migration preserves deadlines without exposing them to legacy resume queries", async () => {
    const f = await operationFixture();
    try {
        await f.client`ALTER TABLE mira_switches DROP CONSTRAINT mira_switches_skill_resume`;
        await f.client`ALTER TABLE mira_switches DROP COLUMN skill_resume_at`;
        const until = new Date(Date.now() + 60_000);
        await f.client`INSERT INTO mira_switches(owner,key,enabled,reason,until,version) VALUES
            ('operator','skill:task-tracking',false,'Review guidance',${until},9),
            ('operator','voice',false,'Review voice',${until},3)`;
        const migration = await Bun.file(
            new URL(
                "../../../migrations/20261026094850_mira_skill_resume/migration.sql",
                import.meta.url
            )
        ).text();
        for (const statement of migration.split("--> statement-breakpoint"))
            if (statement.trim()) await f.client.unsafe(statement);
        const rows = await f.client<
            { key: string; until: Date | null; resume: Date | null; version: number }[]
        >`
            SELECT key,until,skill_resume_at AS resume,version FROM mira_switches WHERE owner='operator' ORDER BY key`;
        expect([...rows]).toEqual([
            { key: "skill:task-tracking", until: null, resume: until, version: 9 },
            { key: "voice", until, resume: null, version: 3 },
        ]);
    } finally {
        await f.close();
    }
});
