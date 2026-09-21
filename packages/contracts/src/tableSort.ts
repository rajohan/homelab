import * as v from "valibot";

const sortSchema = v.strictObject({
    id: v.pipe(v.string(), v.minLength(1), v.maxLength(50)),
    direction: v.picklist(["ascending", "descending"]),
});
export type TableSort = v.InferOutput<typeof sortSchema>;
export type TableSortValue = string | number | boolean | null | undefined;
const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

function missing(value: TableSortValue): boolean {
    return (
        value === null ||
        value === undefined ||
        (typeof value === "number" && !Number.isFinite(value))
    );
}

/**
 * Compare typed cell values, placing missing values last in either direction.
 * @param left - Raw value, not formatted presentation text.
 * @param right - Raw value to compare against.
 * @param direction - Requested ordering.
 * @returns A negative, zero or positive comparator result.
 */
export function compareTableValues(
    left: TableSortValue,
    right: TableSortValue,
    direction: TableSort["direction"]
): number {
    if (missing(left) || missing(right))
        return Number(missing(left)) - Number(missing(right));
    const result =
        typeof left === "number" && typeof right === "number"
            ? left - right
            : collator.compare(String(left), String(right));
    return direction === "ascending" ? result : -result;
}
export const tableCursorSchema = v.strictObject({
    id: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
    sort: sortSchema,
    value: v.nullable(
        v.union([
            v.pipe(v.string(), v.maxLength(500)),
            v.pipe(v.number(), v.finite()),
            v.boolean(),
        ])
    ),
});
export type TableCursor = v.InferOutput<typeof tableCursorSchema>;

/**
 * Limit remote sorting to this endpoint's explicitly exposed column identifiers.
 * @param columns - Public, code-owned sort identifiers, never SQL expressions.
 * @returns A strict optional-sort value schema.
 */
export function tableSortSchema(columns: readonly string[]) {
    return v.pipe(
        sortSchema,
        v.check((sort) => columns.includes(sort.id), "Unknown sort column")
    );
}
