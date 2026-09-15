import { sql } from "drizzle-orm";
import * as v from "valibot";

import type { AuthDatabase } from "../database/connection";
import { AuthFailure } from "../security/errors";

/**
 * Serialize an interaction across service processes before reading or recording decisions.
 * @param database - A dedicated one-connection pool, separate from provider operations.
 * @param interactionId - The opaque, provider-validated interaction identity.
 * @param complete - Rereads the current interaction and applies one decision while locked.
 * @returns Completion after releasing the transaction-scoped lock, including on failure.
 * @throws {AuthFailure} Another process is already completing this same interaction.
 */
export async function serializeInteraction(
    database: AuthDatabase,
    interactionId: string,
    complete: () => Promise<void>
): Promise<void> {
    await database.transaction(async (transaction) => {
        const [lock] = v.parse(
            v.tuple([v.object({ acquired: v.boolean() })]),
            await transaction.execute(
                sql`select pg_try_advisory_xact_lock(hashtextextended(${"homelab:oidc:" + interactionId}, 0)) as acquired`
            )
        );
        if (!lock.acquired)
            throw new AuthFailure(
                "CONSENT_BUSY",
                409,
                "This sign-in request is already being processed. Try again."
            );
        await complete();
    });
}
