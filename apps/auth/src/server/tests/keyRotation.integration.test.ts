import { expect, test } from "bun:test";

import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import * as v from "valibot";

import { createTestDatabase } from "../../../../../tests/database";
import { connectAuthDatabase } from "../database/connection";
import { authMigrationsFolder } from "../database/migrations";
import {
    challenges,
    factors,
    grantSessions,
    logoutOutbox,
    mailOutbox,
    oidcRecords,
    sessions,
    users,
} from "../database/schema";
import { decryptValue, encryptValue } from "../security/crypto";
import { encryptedRecords, rotateDataKey } from "../security/keyRotation";

test("key rotation covers every encrypted column, preserves payloads and atomically rolls back failures", async () => {
    const testDatabase = await createTestDatabase();
    const connection = connectAuthDatabase(testDatabase.url);
    const oldKey = crypto.getRandomValues(new Uint8Array(32));
    const newKey = crypto.getRandomValues(new Uint8Array(32));
    const payload = {
        secret: "synthetic-only",
        nested: { text: "Unicode: æøå", count: 17 },
        list: [true, null],
    };
    const now = new Date();
    const expires = new Date(now.getTime() + 60_000);
    const userId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const factorId = crypto.randomUUID();
    const mailId = crypto.randomUUID();
    const encrypted = (purpose: string) => encryptValue(oldKey, purpose, payload);
    const rowsSchema = v.array(v.object({ id: v.string(), data: v.string() }));
    async function snapshot() {
        const result: Record<string, v.InferOutput<typeof rowsSchema>> = {};
        for (const entry of encryptedRecords)
            result[entry.table] = v.parse(
                rowsSchema,
                await connection.database.execute(sql`
                SELECT ${sql.identifier(entry.key)}::text AS id, ${sql.identifier(entry.column)} AS data
                FROM ${sql.identifier(entry.table)} WHERE ${sql.identifier(entry.column)} IS NOT NULL
                ORDER BY ${sql.identifier(entry.key)}
            `)
            );
        return result;
    }
    try {
        await migrate(connection.database, { migrationsFolder: authMigrationsFolder() });
        const columns = v.parse(
            v.array(v.object({ table_name: v.string(), column_name: v.string() })),
            await connection.database
                .execute(sql`SELECT table_name, column_name FROM information_schema.columns
                WHERE table_schema = 'public' AND column_name LIKE 'encrypted_%'`)
        );
        expect(
            columns.map((row) => row.table_name + "." + row.column_name).toSorted()
        ).toEqual(
            encryptedRecords.map((entry) => entry.table + "." + entry.column).toSorted()
        );
        await connection.database.insert(users).values({
            id: userId,
            username: "rotation-test",
            email: "rotation@example.test",
            passwordHash: "synthetic-password-hash",
            groups: ["admins"],
            createdAt: now,
        });
        await connection.database.insert(sessions).values({
            id: sessionId,
            userId,
            tokenHash: "synthetic-session",
            createdAt: now,
            lastSeenAt: now,
            expiresAt: expires,
            passwordAt: now,
            userAgent: "test",
        });
        await connection.database.insert(factors).values(
            Array.from({ length: 101 }, (_, index) => {
                const id = index === 0 ? factorId : crypto.randomUUID();
                return {
                    id,
                    userId,
                    kind: "totp" as const,
                    label: "test",
                    encryptedData: encrypted("factor:" + id),
                    createdAt: now,
                };
            })
        );
        await connection.database.insert(challenges).values({
            digest: "challenge-test",
            userId,
            sessionId,
            purpose: "test",
            encryptedData: encrypted("challenge:challenge-test"),
            expiresAt: expires,
        });
        await connection.database.insert(oidcRecords).values({
            digest: "oidc-test",
            model: "Session",
            encryptedData: encrypted("oidc:oidc-test"),
            expiresAt: expires,
        });
        await connection.database.insert(mailOutbox).values({
            id: mailId,
            encryptedData: encrypted("mail:" + mailId),
            createdAt: now,
            expiresAt: expires,
            nextAttemptAt: now,
        });
        await connection.database.insert(grantSessions).values([
            {
                grantId: "grant-test",
                sessionId,
                userId,
                encryptedLogout: encrypted("logout:grant-test"),
            },
            { grantId: "without-logout", sessionId, userId },
        ]);
        await connection.database.insert(logoutOutbox).values({
            id: "logout-test",
            encryptedData: encrypted("logout:logout-test"),
            createdAt: now,
            expiresAt: expires,
            nextAttemptAt: now,
        });
        const original = await snapshot();
        const counts = await rotateDataKey(connection.database, oldKey, newKey, false);
        expect(counts.auth_factors).toBe(101);
        expect(Object.values(counts).reduce((sum, count) => sum + count, 0)).toBe(106);
        expect(await snapshot()).toEqual(original);
        for (const [from, to] of [
            [oldKey, oldKey],
            [new Uint8Array(4), newKey],
            [newKey, oldKey],
        ]) {
            if (!from || !to) throw new Error("Invalid test key");
            await rotateDataKey(connection.database, from, to, true).then(
                () => {
                    throw new Error("Invalid rotation unexpectedly committed");
                },
                (error: unknown) => {
                    expect(error).toBeInstanceOf(Error);
                }
            );
            expect(await snapshot()).toEqual(original);
        }
        await connection.database.execute(
            sql`UPDATE auth_logout_outbox SET encrypted_data = 'broken' WHERE id = 'logout-test'`
        );
        const corrupt = await snapshot();
        await rotateDataKey(connection.database, oldKey, newKey, true).then(
            () => {
                throw new Error("Corrupt record unexpectedly accepted");
            },
            (error: unknown) => {
                expect(error).toBeInstanceOf(Error);
            }
        );
        expect(await snapshot()).toEqual(corrupt);
        const last = original.auth_logout_outbox?.[0];
        if (!last) throw new Error("Missing logout fixture");
        await connection.database.execute(
            sql`UPDATE auth_logout_outbox SET encrypted_data = ${last.data} WHERE id = 'logout-test'`
        );
        expect(await rotateDataKey(connection.database, oldKey, newKey, true)).toEqual(
            counts
        );
        const rotated = await snapshot();
        for (const entry of encryptedRecords)
            for (const row of rotated[entry.table] ?? []) {
                expect(
                    decryptValue(newKey, entry.purpose + ":" + row.id, row.data)
                ).toEqual(payload);
                expect(() =>
                    decryptValue(oldKey, entry.purpose + ":" + row.id, row.data)
                ).toThrow();
            }
        const accounts = await connection.database.select().from(users);
        expect(accounts[0]?.passwordHash).toBe("synthetic-password-hash");
        expect(accounts[0]?.id).toBe(userId);
        await rotateDataKey(connection.database, newKey, oldKey, true);
        const returned = await snapshot();
        for (const entry of encryptedRecords)
            for (const row of returned[entry.table] ?? [])
                expect(
                    decryptValue(oldKey, entry.purpose + ":" + row.id, row.data)
                ).toEqual(payload);
    } finally {
        await connection.client.close();
        await testDatabase.close();
    }
});
