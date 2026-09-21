import { expect, test } from "bun:test";

import { capabilities } from "@homelab/contracts/operations";
import type { TableCursor } from "@homelab/contracts/tableSort";

import { formatJobActor } from "../../browser/features/jobs/formatJobActor";
import { appRouter } from "../api/router";
import { maintenanceJob } from "../jobs/maintenance";
import { enqueueJob, lockQueue } from "../jobs/queue";
import { sortedPage } from "../operations/sortedPage";
import { operationFixture, expectOperationFailure } from "../testing/operations";

test("job actor sorting matches displayed labels across ascending and descending pages", async () => {
    const fixture = await operationFixture();
    const actors = ["human:z", "system:a", "automation:a", "human:A", "human:a"];
    try {
        await fixture.client.begin(async (transaction) => {
            await lockQueue(transaction);
            for (const actor of actors)
                await enqueueJob(
                    transaction,
                    maintenanceJob(30).definition,
                    actor,
                    `actor-sort:${actor}`
                );
        });
        const caller = appRouter.createCaller({
            operations: fixture,
            principal: { kind: "human", id: "operator", capabilities },
        });
        for (const direction of ["ascending", "descending"] as const) {
            let cursor: TableCursor | undefined;
            const actual: string[] = [];
            do {
                const page = await caller.jobs.list({
                    sort: { id: "actor", direction },
                    cursor,
                    limit: 1,
                });
                for (const run of page.runs) {
                    actual.push(run.requestedBy);
                    expect(run).not.toHaveProperty("actorLabel");
                }
                cursor = page.nextSortCursor ?? undefined;
            } while (cursor);
            const expected = actors
                .map((actor) => formatJobActor(actor))
                .map((label) => label.toLowerCase())
                .toSorted();
            if (direction === "descending") expected.reverse();
            expect(
                actual
                    .map((actor) => formatJobActor(actor))
                    .map((label) => label.toLowerCase())
            ).toEqual(expected);
            expect(new Set(actual)).toEqual(new Set(actors));
        }
    } finally {
        await fixture.close();
    }
});

test("SQL table cursors preserve numeric order, stable ties and nulls across every page", async () => {
    const fixture = await operationFixture();
    try {
        await fixture.client.begin(async (transaction) => {
            await transaction`CREATE TEMPORARY TABLE sorting_fixture (id text PRIMARY KEY, value int, name text) ON COMMIT DROP`;
            await transaction`INSERT INTO sorting_fixture VALUES ('a',30,'Zeta'),('b',NULL,'alpha'),('c',2,'Beta'),('d',2,'beta')`;
            for (const direction of ["ascending", "descending"] as const) {
                let cursor: TableCursor | undefined;
                const ids: string[] = [];
                do {
                    const page = await sortedPage<{ id: string }>(
                        transaction,
                        transaction`SELECT * FROM sorting_fixture WHERE id != ${cursor?.id ?? ""}`,
                        { size: "value" },
                        { id: "size", direction },
                        cursor,
                        1
                    );
                    ids.push(...page.items.map((row) => row.id));
                    cursor = page.nextSortCursor ?? undefined;
                } while (cursor);
                expect(ids).toEqual(
                    direction === "ascending"
                        ? ["c", "d", "a", "b"]
                        : ["a", "c", "d", "b"]
                );
            }
            const page = await sortedPage<{ id: string }>(
                transaction,
                transaction`SELECT * FROM sorting_fixture`,
                { name: "name" },
                { id: "name", direction: "ascending" },
                undefined,
                2
            );
            expect(page.items.map((row) => row.id)).toEqual(["b", "c"]);
            const next = await sortedPage<{ id: string }>(
                transaction,
                transaction`SELECT * FROM sorting_fixture`,
                { name: "name" },
                { id: "name", direction: "ascending" },
                page.nextSortCursor ?? undefined,
                2
            );
            expect(next.items.map((row) => row.id)).toEqual(["d", "a"]);
            await expectOperationFailure(
                sortedPage(
                    transaction,
                    transaction`SELECT * FROM sorting_fixture`,
                    { size: "value" },
                    { id: "not-an-identifier", direction: "ascending" },
                    undefined,
                    2
                ),
                "sorting cursor"
            );
        });
    } finally {
        await fixture.close();
    }
});
