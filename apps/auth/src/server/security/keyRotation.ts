import { sql } from "drizzle-orm";
import * as v from "valibot";

import type { AuthDatabase } from "../database/connection";
import { decryptValue, encryptValue } from "./crypto";

export const encryptedRecords = [
    { table: "auth_factors", key: "id", column: "encrypted_data", purpose: "factor" },
    {
        table: "auth_challenges",
        key: "digest",
        column: "encrypted_data",
        purpose: "challenge",
    },
    {
        table: "auth_oidc_records",
        key: "digest",
        column: "encrypted_data",
        purpose: "oidc",
    },
    { table: "auth_mail_outbox", key: "id", column: "encrypted_data", purpose: "mail" },
    {
        table: "auth_grant_sessions",
        key: "grant_id",
        column: "encrypted_logout",
        purpose: "logout",
    },
    {
        table: "auth_logout_outbox",
        key: "id",
        column: "encrypted_data",
        purpose: "logout",
    },
] as const;
const rowsSchema = v.array(v.object({ id: v.string(), data: v.string() }));

/**
 * Verify or replace every stored AEAD envelope in one all-or-nothing transaction.
 * All auth processes must be stopped; locks alone cannot prevent old-key writes after commit.
 * @param database - The isolated auth database, with no concurrent application writers.
 * @param oldKey - The currently configured data key.
 * @param newKey - A different, privately retained 32-byte replacement key.
 * @param apply - Commit replacements when true; otherwise verify without writes.
 * @returns Processed record counts, never keys or decrypted data.
 * @throws {Error} Invalid keys, corrupt records or database failures abort the transaction.
 */
export async function rotateDataKey(
    database: AuthDatabase,
    oldKey: Uint8Array,
    newKey: Uint8Array,
    apply: boolean
): Promise<Record<string, number>> {
    if (
        oldKey.length !== 32 ||
        newKey.length !== 32 ||
        Buffer.from(oldKey).equals(Buffer.from(newKey))
    )
        throw new Error("Rotation requires two different 32-byte keys");
    return database.transaction(async (transaction) => {
        await transaction.execute(sql`SET LOCAL lock_timeout = '5s'`);
        await transaction.execute(
            sql`LOCK TABLE ${sql.join(
                encryptedRecords.map((entry) => sql.identifier(entry.table)),
                sql`, `
            )} IN ACCESS EXCLUSIVE MODE`
        );
        const counts: Record<string, number> = {};
        for (const entry of encryptedRecords) {
            const table = sql.identifier(entry.table);
            const key = sql.identifier(entry.key);
            const column = sql.identifier(entry.column);
            let cursor: string | undefined;
            let count = 0;
            while (true) {
                const rows = v.parse(
                    rowsSchema,
                    await transaction.execute(sql`
                    SELECT ${key}::text AS id, ${column} AS data FROM ${table}
                    WHERE ${column} IS NOT NULL
                    ${entry.table === "auth_mail_outbox" ? sql`AND NOT (sent_at IS NOT NULL AND ${column} = '')` : sql``}
                    ${cursor === undefined ? sql`` : sql`AND ${key} > ${cursor}`}
                    ORDER BY ${key} LIMIT 100
                `)
                );
                if (rows.length === 0) break;
                for (const row of rows) {
                    const purpose = `${entry.purpose}:${row.id}`;
                    const data = decryptValue(oldKey, purpose, row.data);
                    const encrypted = encryptValue(newKey, purpose, data);
                    if (
                        JSON.stringify(decryptValue(newKey, purpose, encrypted)) !==
                        JSON.stringify(data)
                    )
                        throw new Error("Re-encryption verification failed");
                    if (apply)
                        await transaction.execute(sql`
                            UPDATE ${table} SET ${column} = ${encrypted} WHERE ${key} = ${row.id}
                        `);
                    cursor = row.id;
                    count += 1;
                }
            }
            counts[entry.table] = count;
        }
        return counts;
    });
}
