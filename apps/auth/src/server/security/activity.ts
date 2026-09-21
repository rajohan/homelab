import {
    tableSortSchema,
    tableCursorSchema,
    type TableSort,
    type TableCursor,
} from "@homelab/contracts/tableSort";
import { and, asc, desc, eq, gt, lt, or, sql } from "drizzle-orm";
import * as v from "valibot";

import { auditEvents } from "../database/schema";
import type { Accounts, Principal } from "./accounts";
import { AuthFailure } from "./errors";

const cursorSchema = v.strictObject({
    id: v.pipe(v.string(), v.uuid()),
    createdAt: v.pipe(v.string(), v.isoTimestamp()),
});
const pageSize = 50;

/**
 * Read one account-scoped audit page in stable reverse chronological order.
 * @param accounts - The identity service supplying the database and authentication checks.
 * @param principal - The authenticated account whose events may be read.
 * @param cursor - An opaque page boundary, never an account selector.
 * @param order - Optional serialized sort specification, restricted to public columns.
 * @returns Redacted events and the next page boundary without renewing session activity.
 */
export async function accountActivity(
    accounts: Accounts,
    principal: Principal,
    cursor: string | null,
    order: string | null = null
) {
    await accounts.requireAuthenticated(principal);
    let boundary: v.InferOutput<typeof cursorSchema> | undefined;
    let sort: TableSort | undefined;
    let sortedBoundary: TableCursor | undefined;
    try {
        if (order !== null) {
            if (order.length > 256) throw new Error("Invalid sorting");
            sort = v.parse(
                tableSortSchema(["event", "who", "time", "details"]),
                JSON.parse(order) as unknown
            );
        }
        if (cursor !== null) {
            if (cursor.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(cursor))
                throw new Error("Invalid cursor");
            const decoded: unknown = JSON.parse(
                Buffer.from(cursor, "base64url").toString("utf8")
            );
            if (sort) {
                sortedBoundary = v.parse(tableCursorSchema, decoded);
                if (
                    sortedBoundary.sort.id !== sort.id ||
                    sortedBoundary.sort.direction !== sort.direction ||
                    typeof sortedBoundary.value !== "string" ||
                    !v.is(v.pipe(v.string(), v.uuid()), sortedBoundary.id)
                )
                    throw new Error("Mismatched cursor");
            } else boundary = v.parse(cursorSchema, decoded);
        }
    } catch {
        throw new AuthFailure(
            "INVALID_CURSOR",
            400,
            "Refresh the activity list and try again."
        );
    }
    // These values are code-owned SQL expressions, never interpolated column names.
    // The timestamp cursor retains microseconds rather than round-tripping through Date.
    const timestamp = sql<string>`to_char(${auditEvents.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
    let sortValue = timestamp;
    if (sort?.id === "event" || sort?.id === "details")
        sortValue = sql<string>`lower(${auditEvents.event})`;
    else if (sort?.id === "who")
        sortValue = sql<string>`${principal.user.username}::text`;
    const compare = sort?.direction === "ascending" ? gt : lt;
    let boundaryCondition: ReturnType<typeof or>;
    if (sortedBoundary)
        boundaryCondition = or(
            compare(sortValue, sortedBoundary.value),
            and(
                eq(sortValue, sortedBoundary.value),
                gt(auditEvents.id, sortedBoundary.id)
            )
        );
    else if (boundary)
        boundaryCondition = or(
            lt(auditEvents.createdAt, sql`${boundary.createdAt}::timestamptz`),
            and(
                eq(auditEvents.createdAt, sql`${boundary.createdAt}::timestamptz`),
                lt(auditEvents.id, boundary.id)
            )
        );
    const orderExpression =
        sort?.direction === "ascending" ? asc(sortValue) : desc(sortValue);
    const rows = await accounts.database
        .select({
            id: auditEvents.id,
            event: auditEvents.event,
            createdAt: auditEvents.createdAt,
            sortValue,
        })
        .from(auditEvents)
        .where(and(eq(auditEvents.userId, principal.user.id), boundaryCondition))
        .orderBy(
            sort ? orderExpression : desc(auditEvents.createdAt),
            sort ? asc(auditEvents.id) : desc(auditEvents.id)
        )
        .limit(pageSize + 1);
    const page = rows.slice(0, pageSize),
        last = page.at(-1);
    return {
        events: page.map(({ sortValue: _sortValue, ...event }) => ({
            ...event,
            account: principal.user.username,
        })),
        nextCursor:
            rows.length > pageSize && last
                ? Buffer.from(
                      JSON.stringify(
                          sort
                              ? { id: last.id, sort, value: last.sortValue }
                              : {
                                    id: last.id,
                                    createdAt: last.sortValue,
                                }
                      )
                  ).toString("base64url")
                : null,
    };
}
