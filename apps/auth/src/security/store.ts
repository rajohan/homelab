import { and, eq, gt, sql } from "drizzle-orm";

import type { AuthStore } from "../database/connection";
import { auditEvents, challenges, rateBuckets } from "../database/schema";
import { decryptValue, encryptValue, randomToken, tokenDigest } from "./crypto";
import { AuthFailure, invalidProof } from "./errors";

export function audit(
    store: AuthStore,
    userId: string | null,
    event: string,
    now = new Date()
) {
    return store
        .insert(auditEvents)
        .values({ id: crypto.randomUUID(), userId, event, createdAt: now });
}

export async function rateLimit(
    store: AuthStore,
    bucket: string,
    limit: number,
    periodMs: number,
    now = new Date()
): Promise<void> {
    const digest = tokenDigest(bucket);
    const expiresAt = new Date(now.getTime() + periodMs);
    const [result] = await store
        .insert(rateBuckets)
        .values({ digest, attempts: 1, expiresAt })
        .onConflictDoUpdate({
            target: rateBuckets.digest,
            set: {
                attempts: sql`CASE WHEN ${rateBuckets.expiresAt} <= ${now} THEN 1 ELSE ${rateBuckets.attempts} + 1 END`,
                expiresAt: sql`CASE WHEN ${rateBuckets.expiresAt} <= ${now} THEN ${expiresAt} ELSE ${rateBuckets.expiresAt} END`,
            },
        })
        .returning({ attempts: rateBuckets.attempts });
    if (!result || result.attempts > limit)
        throw new AuthFailure("RATE_LIMITED", 429, "Too many attempts. Try again later.");
}

export async function createChallenge(
    store: AuthStore,
    key: Uint8Array,
    userId: string,
    sessionId: string | null,
    purpose: string,
    data: unknown,
    lifetimeMs = 300_000
): Promise<string> {
    const token = randomToken();
    const digest = tokenDigest(token);
    await store.insert(challenges).values({
        digest,
        userId,
        sessionId,
        purpose,
        encryptedData: encryptValue(key, `challenge:${digest}`, data),
        expiresAt: new Date(Date.now() + lifetimeMs),
    });
    return token;
}

export async function takeChallenge(
    store: AuthStore,
    key: Uint8Array,
    token: string,
    purpose: string,
    userId?: string,
    sessionId?: string
): Promise<{ userId: string; sessionId: string | null; data: unknown }> {
    const digest = tokenDigest(token);
    const conditions = [
        eq(challenges.digest, digest),
        eq(challenges.purpose, purpose),
        gt(challenges.expiresAt, new Date()),
    ];
    if (userId) conditions.push(eq(challenges.userId, userId));
    if (sessionId) conditions.push(eq(challenges.sessionId, sessionId));
    const [challenge] = await store
        .delete(challenges)
        .where(and(...conditions))
        .returning();
    if (!challenge) invalidProof();
    return {
        userId: challenge.userId,
        sessionId: challenge.sessionId,
        data: decryptValue(key, `challenge:${digest}`, challenge.encryptedData),
    };
}
