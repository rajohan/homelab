import { and, eq, gt, isNull, isNotNull } from "drizzle-orm";
import { errors, type Adapter, type AdapterPayload } from "oidc-provider";
import * as v from "valibot";

import type { AuthSessionPolicy } from "../config/sessionPolicy";
import type { AuthDatabase } from "../database/connection";
import { grantSessions, oidcRecords, sessions } from "../database/schema";
import { liveSessionCondition } from "../database/sessionValidity";
import { decryptValue, encryptValue, tokenDigest } from "../security/crypto";
import { revokeBoundGrants } from "./logout";

/**
 * Create the provider's encrypted PostgreSQL adapter with central-session grant checks.
 * @param database - The auth database.
 * @param key - The data-encryption key for OIDC payloads.
 * @param policy - The absolute and idle lifetimes enforced for every bound token.
 * @returns The adapter class instantiated by oidc-provider for each model.
 */
export function createOidcAdapter(
    database: AuthDatabase,
    key: Uint8Array,
    policy: AuthSessionPolicy
) {
    return class PersistentAdapter implements Adapter {
        readonly model: string;
        /**
         * Bind an adapter instance to one provider model namespace.
         * @param model - The OIDC model whose records this instance stores.
         */
        constructor(model: string) {
            this.model = model;
        }

        /**
         * Encrypt and insert or replace a provider record with its expiry and lookup indexes.
         * @param id - The provider record identifier.
         * @param payload - The provider payload to encrypt.
         * @param expiresIn - The record lifetime in seconds.
         * @returns Completion after the record is stored.
         */
        async upsert(
            id: string,
            payload: AdapterPayload,
            expiresIn = 3600
        ): Promise<void> {
            const digest = tokenDigest(`${this.model}:${id}`);
            const row = {
                digest,
                model: this.model,
                encryptedData: encryptValue(key, `oidc:${digest}`, payload),
                expiresAt: new Date(Date.now() + expiresIn * 1000),
                grantId: payload.grantId ? tokenDigest(payload.grantId) : null,
                uid: payload.uid ? tokenDigest(payload.uid) : null,
                userCode: payload.userCode ? tokenDigest(payload.userCode) : null,
            };
            await database
                .insert(oidcRecords)
                .values(row)
                .onConflictDoUpdate({ target: oidcRecords.digest, set: row });
        }

        /**
         * Decrypt a stored payload only while any bound central session remains live.
         * @param row - The stored record, or undefined when lookup found nothing.
         * @returns The usable provider payload, or undefined for an invalid session or missing record.
         */
        async decode(
            row: typeof oidcRecords.$inferSelect | undefined
        ): Promise<AdapterPayload | undefined> {
            if (!row) return undefined;
            if (row.grantId) {
                const [grant] = await database
                    .select({ id: sessions.id })
                    .from(grantSessions)
                    .innerJoin(sessions, eq(sessions.id, grantSessions.sessionId))
                    .where(
                        and(
                            eq(grantSessions.grantId, row.grantId),
                            isNotNull(grantSessions.clientId),
                            liveSessionCondition(policy)
                        )
                    )
                    .limit(1);
                if (!grant) return undefined;
            }
            const payload = v.parse(
                v.record(v.string(), v.unknown()),
                decryptValue(key, `oidc:${row.digest}`, row.encryptedData)
            ) as AdapterPayload;
            return row.consumedAt === null
                ? payload
                : { ...payload, consumed: row.consumedAt };
        }

        /**
         * Find an unexpired provider record by its model-scoped identifier.
         * @param id - The provider record identifier.
         * @returns The usable provider payload, if present.
         */
        async find(id: string): Promise<AdapterPayload | undefined> {
            const [row] = await database
                .select()
                .from(oidcRecords)
                .where(
                    and(
                        eq(oidcRecords.digest, tokenDigest(`${this.model}:${id}`)),
                        gt(oidcRecords.expiresAt, new Date())
                    )
                );
            return this.decode(row);
        }

        /**
         * Find an unexpired model record through a hashed provider UID.
         * @param uid - The provider UID.
         * @returns The usable provider payload, if present.
         */
        async findByUid(uid: string): Promise<AdapterPayload | undefined> {
            const [row] = await database
                .select()
                .from(oidcRecords)
                .where(
                    and(
                        eq(oidcRecords.model, this.model),
                        eq(oidcRecords.uid, tokenDigest(uid)),
                        gt(oidcRecords.expiresAt, new Date())
                    )
                );
            return this.decode(row);
        }

        /**
         * Find an unexpired model record through a hashed user code.
         * @param userCode - The device-flow user code.
         * @returns The usable provider payload, if present.
         */
        async findByUserCode(userCode: string): Promise<AdapterPayload | undefined> {
            const [row] = await database
                .select()
                .from(oidcRecords)
                .where(
                    and(
                        eq(oidcRecords.model, this.model),
                        eq(oidcRecords.userCode, tokenDigest(userCode)),
                        gt(oidcRecords.expiresAt, new Date())
                    )
                );
            return this.decode(row);
        }

        /**
         * Atomically consume an unexpired provider record once.
         * @param id - The provider record identifier.
         * @returns Completion after the first successful consumption.
         */
        async consume(id: string): Promise<void> {
            const [row] = await database
                .update(oidcRecords)
                .set({ consumedAt: Math.floor(Date.now() / 1000) })
                .where(
                    and(
                        eq(oidcRecords.digest, tokenDigest(`${this.model}:${id}`)),
                        isNull(oidcRecords.consumedAt),
                        gt(oidcRecords.expiresAt, new Date())
                    )
                )
                .returning({ id: oidcRecords.digest });
            if (!row)
                throw new errors.InvalidGrant(
                    "The grant has already been used or expired."
                );
        }

        /**
         * Delete a single model-scoped provider record.
         * @param id - The provider record identifier.
         * @returns Completion after deletion.
         */
        async destroy(id: string): Promise<void> {
            await database
                .delete(oidcRecords)
                .where(eq(oidcRecords.digest, tokenDigest(`${this.model}:${id}`)));
        }

        /**
         * Revoke grant-bound records and preserve logout notifications in one transaction.
         * @param id - The provider grant identifier.
         * @returns Completion after the grant revocation commits.
         */
        async revokeByGrantId(id: string): Promise<void> {
            await database.transaction(async (transaction) => {
                await revokeBoundGrants(
                    transaction,
                    eq(grantSessions.grantId, tokenDigest(id))
                );
                await transaction
                    .delete(oidcRecords)
                    .where(eq(oidcRecords.grantId, tokenDigest(id)));
            });
        }
    };
}
