import { expect, test } from "bun:test";

import type { TableCursor } from "@homelab/contracts/tableSort";

import { sortedPage } from "../operations/sortedPage";
import { operationFixture, expectOperationFailure } from "../testing/operations";

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
