import { and, eq, gt, inArray, lte, type SQL } from "drizzle-orm";
import type { Provider } from "oidc-provider";
import * as v from "valibot";

import type { AuthConfiguration } from "../config/configuration";
import type { AuthDatabase, AuthStore } from "../database/connection";
import { grantSessions, logoutOutbox, oidcRecords } from "../database/schema";
import { decryptValue } from "../security/crypto";

export const logoutPayloadSchema = v.strictObject({
    clientId: v.string(),
    accountId: v.string(),
    sid: v.pipe(v.string(), v.minLength(1)),
    uri: v.pipe(v.string(), v.url()),
});

/**
 * Remove grants and preserve notifications before their session is deleted.
 * @param store - The caller's transaction, shared with session revocation.
 * @param condition - The exact grant selection to revoke.
 * @returns Completion after grants and notifications have been updated.
 */
export async function revokeBoundGrants(store: AuthStore, condition: SQL): Promise<void> {
    const grants = await store.delete(grantSessions).where(condition).returning();
    const now = new Date();
    for (const grant of grants) {
        if (grant.encryptedLogout)
            await store
                .insert(logoutOutbox)
                .values({
                    id: grant.grantId,
                    encryptedData: grant.encryptedLogout,
                    createdAt: now,
                    expiresAt: new Date(now.getTime() + 86_400_000),
                    nextAttemptAt: now,
                })
                .onConflictDoNothing();
    }
    if (grants.length > 0)
        await store.delete(oidcRecords).where(
            inArray(
                oidcRecords.grantId,
                grants.map((grant) => grant.grantId)
            )
        );
}

/**
 * Deliver a bounded batch through the provider's native signed logout implementation.
 * @param database - The auth store containing the encrypted outbox.
 * @param configuration - Current keys and permitted client endpoints.
 * @param provider - The pinned OIDC engine that signs session-specific logout tokens.
 * @returns The number of deliveries completed; failed requests remain queued.
 */
export async function deliverLogouts(
    database: AuthDatabase,
    configuration: AuthConfiguration,
    provider: Provider
): Promise<number> {
    let delivered = 0;
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const handled = await database.transaction(async (transaction) => {
            const now = new Date();
            const [message] = await transaction
                .select()
                .from(logoutOutbox)
                .where(
                    and(
                        lte(logoutOutbox.nextAttemptAt, now),
                        gt(logoutOutbox.expiresAt, now)
                    )
                )
                .orderBy(logoutOutbox.createdAt)
                .limit(1)
                .for("update", { skipLocked: true });
            if (!message) return false;
            try {
                const payload = v.parse(
                    logoutPayloadSchema,
                    decryptValue(
                        configuration.encryptionKey,
                        `logout:${message.id}`,
                        message.encryptedData
                    )
                );
                const metadata = configuration.clients.find(
                    (client) => client.client_id === payload.clientId
                );
                // Do not deliver old session data to a changed or removed client endpoint.
                if (
                    !metadata?.backchannel_logout_uri ||
                    new URL(metadata.backchannel_logout_uri).href !==
                        new URL(payload.uri).href ||
                    metadata.backchannel_logout_session_required !== true
                )
                    throw new Error("Logout client configuration changed");
                const client = await provider.Client.find(payload.clientId);
                if (!client) throw new Error("Logout client unavailable");
                // The pinned library exposes this method; its external @types omit it.
                const sender = client as typeof client & {
                    /**
                     * Send the provider's signed, session-specific back-channel logout token.
                     * @param sub - The client-visible subject of the revoked session.
                     * @param sid - The client session identifier to invalidate.
                     * @returns Completion after the receiver accepts the notification.
                     */
                    backchannelLogout(sub: string, sid: string): Promise<void>;
                };
                await sender.backchannelLogout(payload.accountId, payload.sid);
                await transaction
                    .delete(logoutOutbox)
                    .where(eq(logoutOutbox.id, message.id));
                delivered += 1;
            } catch {
                await transaction
                    .update(logoutOutbox)
                    .set({
                        attempts: message.attempts + 1,
                        nextAttemptAt: new Date(
                            Date.now() +
                                Math.min(
                                    300_000,
                                    15_000 * 2 ** Math.min(message.attempts, 5)
                                )
                        ),
                    })
                    .where(eq(logoutOutbox.id, message.id));
                process.stderr.write(
                    JSON.stringify({
                        service: "auth",
                        event: "oidc_logout_delivery_failed",
                    }) + "\n"
                );
            }
            return true;
        });
        if (!handled) break;
    }
    const expired = await database
        .delete(logoutOutbox)
        .where(lte(logoutOutbox.expiresAt, new Date()))
        .returning({ id: logoutOutbox.id });
    if (expired.length > 0)
        process.stderr.write(
            JSON.stringify({
                service: "auth",
                event: "oidc_logout_delivery_expired",
                count: expired.length,
            }) + "\n"
        );
    return delivered;
}
