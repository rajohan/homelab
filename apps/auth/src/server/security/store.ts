import { and, eq, gt, sql } from "drizzle-orm";

import type { AuthStore } from "../database/connection";
import { auditEvents, challenges, rateBuckets } from "../database/schema";
import { decryptValue, encryptValue, randomToken, tokenDigest } from "./crypto";
import { AuthFailure, invalidProof } from "./errors";

/**
 * Prepare insertion of a redacted account security event.
 * @param store - The database or caller-owned transaction.
 * @param userId - The associated account, or null for an unbound event.
 * @param event - The nonsecret event identifier.
 * @param now - The event timestamp.
 * @returns The insert query, which the caller must await.
 */
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

/**
 * Consume an atomic rate-limit slot using a hashed bucket identifier.
 * @param store - The database or caller-owned transaction.
 * @param bucket - The purpose-bound rate-limit key.
 * @param limit - The allowed operation count within the period.
 * @param periodMs - The bucket lifetime in milliseconds.
 * @param now - The timestamp used to evaluate and renew the bucket.
 * @returns Completion when the request is within its limit.
 */
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

/**
 * Persist an expiring, encrypted challenge under an opaque one-use token.
 * @param store - The database or caller-owned transaction.
 * @param key - The data-encryption key.
 * @param userId - The account bound to the proof.
 * @param sessionId - The initiating session, or null for explicitly sessionless proofs.
 * @param purpose - The operation the proof may authorize.
 * @param data - The proof payload to encrypt.
 * @param lifetimeMs - The validity period in milliseconds.
 * @returns The plaintext token to deliver privately to the client.
 */
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

/**
 * Atomically consume a matching, unexpired proof and decrypt its payload.
 * @param store - The database or caller-owned transaction.
 * @param key - The data-encryption key.
 * @param token - The presented one-use token.
 * @param purpose - The required proof purpose.
 * @param userId - An optional required account binding.
 * @param sessionId - An optional required session binding.
 * @returns The proof's account/session bindings and decoded payload.
 */
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
