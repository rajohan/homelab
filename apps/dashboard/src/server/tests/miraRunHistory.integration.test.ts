import { expect, test } from "bun:test";

import { capabilities } from "@homelab/contracts/operations";
import type { TableCursor } from "@homelab/contracts/tableSort";
import { finishMiraRun } from "@homelab/mira/data/queue";

import { appRouter } from "../api/router";
import { permissionRun } from "../testing/miraPermissions";
import { operationFixture } from "../testing/operations";

test("Mira history sorts across pages and filters only open terminal follow-up", async () => {
    const f = await operationFixture();
    const api = appRouter.createCaller({
        operations: f,
        principal: { kind: "human", id: "operator", capabilities },
    }).mira;
    try {
        const { run } = await permissionRun(f.client, api, "ask");
        await finishMiraRun(f.client, run, {
            state: "completed",
            text: "Done",
            message: null,
        });
        // Clone synthetic run data with unique immutable request identities.
        for (let index = 0; index < 35; index++) {
            const id = Bun.randomUUIDv7();
            await f.client`INSERT INTO mira_runs SELECT (jsonb_populate_record(NULL::mira_runs,
                to_jsonb(r) || jsonb_build_object('id',${id}::text,'request_key',${id}::text,
                    'state','failed','created_at',clock_timestamp()+${index}*interval '1 second'))).*
                FROM mira_runs r WHERE r.id=${run.id}`;
        }
        const sort = { id: "time", direction: "ascending" as const };
        let cursor: TableCursor | undefined;
        const ids: string[] = [];
        do {
            const page = await api.runs.list({
                needsReview: true,
                sort,
                ...(cursor ? { sortCursor: cursor } : {}),
            });
            ids.push(...page.rows.map((row) => row.id));
            expect(
                page.rows.every(
                    (row) => row.state === "failed" && !row.followupResolution
                )
            ).toBe(true);
            cursor = page.nextCursor ?? undefined;
        } while (cursor);
        expect(ids).toHaveLength(35);
        expect(new Set(ids).size).toBe(35);
        await api.runs.resolve({
            id: ids[0]!,
            outcome: "reviewed",
            reason: "Synthetic follow-up checked",
        });
        const filtered = await api.runs.list({ needsReview: true, sort });
        expect(filtered.rows.some((row) => row.id === ids[0])).toBe(false);
        const all = await api.runs.list({
            sort: { id: "state", direction: "ascending" },
        });
        expect(all.rows[0]?.state).toBe("completed");
        const owner = appRouter.createCaller({
            operations: f,
            principal: { kind: "human", id: "other", capabilities },
        }).mira;
        const other = await owner.runs.list({ needsReview: true });
        expect(other.rows).toEqual([]);
    } finally {
        await f.close();
    }
});
