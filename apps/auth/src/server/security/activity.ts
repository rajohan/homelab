import { and, desc, eq, lt, or } from "drizzle-orm";
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
 * @returns Redacted events and the next page boundary without renewing session activity.
 */
export async function accountActivity(
    accounts: Accounts,
    principal: Principal,
    cursor: string | null
) {
    await accounts.requireAuthenticated(principal);
    let boundary: v.InferOutput<typeof cursorSchema> | undefined;
    if (cursor !== null) {
        try {
            if (cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(cursor))
                throw new Error("Invalid cursor");
            boundary = v.parse(
                cursorSchema,
                JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown
            );
        } catch {
            throw new AuthFailure(
                "INVALID_CURSOR",
                400,
                "Refresh the activity list and try again."
            );
        }
    }
    const rows = await accounts.database
        .select({
            id: auditEvents.id,
            event: auditEvents.event,
            createdAt: auditEvents.createdAt,
        })
        .from(auditEvents)
        .where(
            and(
                eq(auditEvents.userId, principal.user.id),
                boundary
                    ? or(
                          lt(auditEvents.createdAt, new Date(boundary.createdAt)),
                          and(
                              eq(auditEvents.createdAt, new Date(boundary.createdAt)),
                              lt(auditEvents.id, boundary.id)
                          )
                      )
                    : undefined
            )
        )
        .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
        .limit(pageSize + 1);
    const page = rows.slice(0, pageSize),
        last = page.at(-1);
    return {
        events: page.map((event) => ({ ...event, account: principal.user.username })),
        nextCursor:
            rows.length > pageSize && last
                ? Buffer.from(
                      JSON.stringify({
                          id: last.id,
                          createdAt: last.createdAt.toISOString(),
                      })
                  ).toString("base64url")
                : null,
    };
}
