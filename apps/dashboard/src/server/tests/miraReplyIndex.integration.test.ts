import { expect, test } from "bun:test";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { readMessageParts } from "@homelab/mira/data/historyMessages";
import type { SQL } from "bun";
import { migrate } from "drizzle-orm/bun-sql/migrator";

import { createTestDatabase } from "../../../../../tests/database";
import { connectDashboardDatabase } from "../database/connection";
import { dashboardMigrationsFolder, migrateDashboard } from "../database/migrations";
import { operationFixture } from "../testing/operations";

test("reply index upgrades old transcripts and follows streaming, replacement and erasure", async () => {
    const allocation = await createTestDatabase();
    const connection = connectDashboardDatabase(allocation.url);
    const prior = await mkdtemp(path.join(tmpdir(), "mira-reply-parent-"));
    try {
        const source = dashboardMigrationsFolder();
        const entries = await readdir(source, { withFileTypes: true });
        const feature = entries.find((entry) => entry.name.endsWith("_mira_reply_index"));
        if (!feature) throw new Error("Missing reply index migration");
        for (const entry of entries.filter(
            (entry) => entry.isDirectory() && entry.name < feature.name
        ))
            await cp(path.join(source, entry.name), path.join(prior, entry.name), {
                recursive: true,
            });
        await migrate(connection.database, { migrationsFolder: prior });
        const chat = Bun.randomUUIDv7(),
            user = Bun.randomUUIDv7(),
            parent = Bun.randomUUIDv7();
        const parts = [
            { id: parent, offset: 0, createdAt: new Date().toISOString() },
            { id: Bun.randomUUIDv7(), offset: 3, createdAt: new Date().toISOString() },
        ];
        await connection.client`INSERT INTO mira_conversations(id,owner,title) VALUES (${chat},'operator','Legacy')`;
        await connection.client`INSERT INTO mira_messages(id,conversation_id,role,state,content) VALUES (${user},${chat},'user','completed','Hello')`;
        await connection.client`INSERT INTO mira_messages(id,conversation_id,role,state,content,parts) VALUES (${parent},${chat},'assistant','streaming','😀\n\nNext',${JSON.stringify(parts)}::text::jsonb)`;
        await migrateDashboard(connection);
        const read = () =>
            readMessageParts(connection.client, "operator", chat, { limit: 50 });
        const upgraded = await read();
        expect(upgraded.map((row) => row.content)).toEqual(["Next", "😀", "Hello"]);
        const [boundary] = await connection.client<
            { version: string }[]
        >`SELECT xmin::text AS version FROM mira_message_replies WHERE id=${parts[1]!.id}`;
        await connection.client`UPDATE mira_messages SET content='😀\n\nNext chunk',parts=${JSON.stringify(parts)}::text::jsonb WHERE id=${parent}`;
        const [unchanged] = await connection.client<
            { version: string }[]
        >`SELECT xmin::text AS version FROM mira_message_replies WHERE id=${parts[1]!.id}`;
        expect(unchanged!.version).toBe(boundary!.version);
        const streaming = await read();
        expect(streaming[0]!.content).toBe("Next chunk");
        await connection.client`UPDATE mira_messages SET state='failed' WHERE id=${parent}`;
        const failed = await read();
        expect(failed.slice(0, 2).map((row) => row.state)).toEqual(["failed", "failed"]);
        await connection.client`UPDATE mira_messages SET content='',parts='[]'::jsonb WHERE id=${parent}`;
        const cleared = await read();
        expect(cleared.map((row) => row.partId)).toEqual([parent, user]);
        expect(cleared[0]!.content).toBe("");
        await connection.client`DELETE FROM mira_messages WHERE conversation_id=${chat}`;
        expect(await read()).toHaveLength(0);
        expect(
            await connection.client`SELECT id FROM mira_message_replies WHERE conversation_id=${chat}`
        ).toHaveLength(0);
    } finally {
        await connection.client.close();
        await allocation.close();
        await rm(prior, { recursive: true, force: true });
    }
});

test("latest and older transcript pages use the reply index without expanding old bodies", async () => {
    const f = await operationFixture();
    try {
        const chat = Bun.randomUUIDv7();
        await f.client`INSERT INTO mira_conversations(id,owner,title) VALUES (${chat},'operator','Long transcript')`;
        await f.client`INSERT INTO mira_messages(id,conversation_id,role,state,content)
            SELECT gen_random_uuid(),${chat},'user','completed',repeat('Historical content. ',400) FROM generate_series(1,5000)`;
        await f.client`ANALYZE mira_messages`;
        await f.client`ANALYZE mira_message_replies`;
        const plans: string[] = [];
        const query = ((strings: TemplateStringsArray, ...values: unknown[]) => {
            if (!strings[0]!.startsWith("WITH page")) return f.client(strings, ...values);
            return f.client`EXPLAIN (ANALYZE, FORMAT JSON) ${f.client(strings, ...values)}`.then(
                (rows) => {
                    plans.push(JSON.stringify(rows));
                    return [];
                }
            );
        }) as unknown as SQL;
        const page = await readMessageParts(f.client, "operator", chat, { limit: 50 });
        for (const options of [{ limit: 50 }, { limit: 50, before: page.at(-1)!.partId }])
            await readMessageParts(query, "operator", chat, options);
        for (const plan of plans) {
            expect(plan).toContain("mira_message_replies_conversation");
            expect(plan).not.toContain("Function Scan");
            const parsed = JSON.parse(plan) as { "QUERY PLAN": { Plan: Plan }[] }[];
            interface Plan {
                "Relation Name"?: string;
                "Actual Rows": number;
                Plans?: Plan[];
            }
            const nodes = (node: Plan): Plan[] => [
                node,
                ...(node.Plans ?? []).flatMap((child) => nodes(child)),
            ];
            const replyScans = nodes(parsed[0]!["QUERY PLAN"][0]!.Plan).filter(
                (node) => node["Relation Name"] === "mira_message_replies"
            );
            expect(replyScans).toHaveLength(1);
            expect(replyScans[0]!["Actual Rows"]).toBeLessThanOrEqual(50);
        }
        expect(plans).toHaveLength(2);
    } finally {
        await f.close();
    }
}, 15_000);
