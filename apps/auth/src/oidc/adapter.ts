import { and, eq, gt, isNull } from "drizzle-orm";
import { errors, type Adapter, type AdapterPayload } from "oidc-provider";
import * as v from "valibot";

import type { AuthDatabase } from "../database/connection";
import { grantSessions, oidcRecords, sessions } from "../database/schema";
import { decryptValue, encryptValue, tokenDigest } from "../security/crypto";

export function createOidcAdapter(database: AuthDatabase, key: Uint8Array) {
    return class PersistentAdapter implements Adapter {
        readonly model: string;
        constructor(model: string) {
            this.model = model;
        }

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
                            gt(sessions.expiresAt, new Date()),
                            gt(sessions.lastSeenAt, new Date(Date.now() - 3_600_000))
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

        async destroy(id: string): Promise<void> {
            await database
                .delete(oidcRecords)
                .where(eq(oidcRecords.digest, tokenDigest(`${this.model}:${id}`)));
        }

        async revokeByGrantId(id: string): Promise<void> {
            await database
                .delete(oidcRecords)
                .where(eq(oidcRecords.grantId, tokenDigest(id)));
            await database
                .delete(grantSessions)
                .where(eq(grantSessions.grantId, tokenDigest(id)));
        }
    };
}
