import { expect, test } from "bun:test";

import type { TableCursor } from "@homelab/contracts/tableSort";

import { sortedInventory } from "./sortedInventory";

test("inventory sorting precedes pagination and does not depend on a retained cursor row", () => {
    const rows = [
        { id: "a", value: 30 },
        { id: "b", value: null },
        { id: "c", value: 2 },
        { id: "d", value: 2 },
    ];
    const fields = { size: (row: (typeof rows)[number]) => row.value };
    for (const direction of ["ascending", "descending"] as const) {
        const sort = { id: "size", direction };
        let cursor: TableCursor | undefined;
        const result: string[] = [];
        do {
            const page = sortedInventory(
                rows.filter((row) => row.id !== cursor?.id),
                fields,
                sort,
                cursor,
                1
            );
            result.push(...page.items.map((row) => row.id));
            cursor = page.nextSortCursor ?? undefined;
        } while (cursor);
        expect(result).toEqual(
            direction === "ascending" ? ["c", "d", "a", "b"] : ["a", "c", "d", "b"]
        );
    }
    expect(() =>
        sortedInventory(
            rows,
            fields,
            { id: "private", direction: "ascending" },
            undefined,
            1
        )
    ).toThrow("sorting cursor");
    expect(() =>
        sortedInventory(
            rows,
            fields,
            { id: "size", direction: "descending" },
            { id: "a", value: 30, sort: { id: "size", direction: "ascending" } },
            1
        )
    ).toThrow("sorting cursor");
});
