import { and, eq, gt, sql, type SQL } from "drizzle-orm";

import type { AuthSessionPolicy } from "../config/sessionPolicy";
import { sessions } from "./schema";

/**
 * Apply the same absolute and idle expiry rules to sessions, tokens and maintenance.
 * @param policy - The configured normal and remembered-session lifetimes.
 * @param now - The cutoff timestamp, shared by a caller's query when needed.
 * @returns A SQL condition accepting only sessions still valid under their chosen policy.
 */
export function liveSessionCondition(policy: AuthSessionPolicy, now = new Date()): SQL {
    const ordinary = and(
        eq(sessions.remember, false),
        gt(sessions.createdAt, new Date(now.getTime() - policy.maximumSeconds * 1000)),
        gt(sessions.lastSeenAt, new Date(now.getTime() - policy.idleSeconds * 1000))
    );
    const remembered = and(
        eq(sessions.remember, true),
        gt(
            sessions.createdAt,
            new Date(now.getTime() - policy.rememberMaximumSeconds * 1000)
        ),
        gt(
            sessions.lastSeenAt,
            new Date(now.getTime() - policy.rememberIdleSeconds * 1000)
        )
    );
    return sql`${gt(sessions.expiresAt, now)} AND (${ordinary} OR ${remembered})`;
}
