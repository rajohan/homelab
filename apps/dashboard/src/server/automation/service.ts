import type {
    AutomationAccount,
    AutomationCredential,
    Capability,
} from "@homelab/contracts/operations";
import type { SQL } from "bun";

import type { Transaction } from "../database/connection";
import { auditOperation } from "../operations/audit";
import { OperationFailure } from "../operations/errors";
import { issueAutomationToken } from "./tokens";

async function lockAccount(
    transaction: Transaction,
    id: string,
    version: number
): Promise<void> {
    const rows = await transaction<
        { id: string }[]
    >`SELECT id FROM automation_accounts WHERE id = ${id} AND version = ${version} AND disabled_at IS NULL FOR UPDATE`;
    if (!rows[0])
        throw new OperationFailure(
            "CONFLICT",
            "The account changed. Refresh before trying again."
        );
}
async function createCredential(
    transaction: Transaction,
    id: string,
    expiresAt: number | null
) {
    if (
        expiresAt !== null &&
        (expiresAt <= Date.now() || expiresAt > Date.now() + 366 * 86_400_000)
    )
        throw new OperationFailure(
            "BAD_REQUEST",
            "Choose an expiry within the next year, or no expiry."
        );
    const active = await transaction<
        { count: number }[]
    >`SELECT count(*)::int AS count FROM automation_credentials WHERE account_id = ${id} AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())`;
    if ((active[0]?.count ?? 5) >= 5)
        throw new OperationFailure(
            "CONFLICT",
            "Revoke an unused token before creating another."
        );
    const material = issueAutomationToken(),
        credentialId = Bun.randomUUIDv7();
    await transaction`INSERT INTO automation_credentials (id, account_id, prefix, digest, expires_at) VALUES (${credentialId}, ${id}, ${material.prefix}, ${material.digest}, ${expiresAt === null ? null : new Date(expiresAt)})`;
    return { credentialId, token: material.token };
}

/**
 * Read a bounded page of machine accounts and the nonsecret credentials belonging to it.
 * @param client - The dashboard database pool.
 * @param before - Optional UUIDv7 page cursor.
 * @returns Account and credential metadata, never token digests.
 */
export async function listAutomation(client: SQL, before?: string) {
    const accounts = await client<
        AutomationAccount[]
    >`SELECT id, label, capabilities, version, disabled_at::text AS "disabledAt", created_at::text AS "createdAt" FROM automation_accounts WHERE (${before ?? null}::uuid IS NULL OR id < ${before ?? null}::uuid) ORDER BY id DESC LIMIT 30`;
    const credentials =
        accounts.length === 0
            ? []
            : await client<AutomationCredential[]>`
        SELECT id, account_id AS "accountId", prefix, created_at::text AS "createdAt", expires_at::text AS "expiresAt", revoked_at::text AS "revokedAt", last_used_at::text AS "lastUsedAt"
        FROM (
            SELECT *, row_number() OVER (PARTITION BY account_id ORDER BY (revoked_at IS NULL AND (expires_at IS NULL OR expires_at > now())) DESC, id DESC) AS position
            FROM automation_credentials WHERE account_id = ANY(${client.array(
                accounts.map((account) => account.id),
                "UUID"
            )})
        ) AS ranked WHERE position <= 10 ORDER BY account_id, id DESC`;
    return {
        accounts,
        credentials,
        nextCursor: accounts.length === 30 ? (accounts.at(-1)?.id ?? null) : null,
    };
}

/**
 * Create an account, its grants and initial one-time token atomically with audit.
 * @param client - The dashboard database pool.
 * @param actor - The freshly verified human operator.
 * @param input - Validated label, grants and expiry.
 * @returns The new account ID and one-time token; callers must not log the result.
 */
export async function createAutomation(
    client: SQL,
    actor: string,
    input: { label: string; capabilities: Capability[]; expiresAt: number | null }
) {
    return client.begin(async (transaction) => {
        const id = Bun.randomUUIDv7();
        await transaction`INSERT INTO automation_accounts (id, label, capabilities) VALUES (${id}, ${input.label}, ${JSON.stringify(input.capabilities)}::text::jsonb)`;
        const credential = await createCredential(transaction, id, input.expiresAt);
        await auditOperation(transaction, actor, "automation.created", id);
        return { id, ...credential };
    });
}

/**
 * Stage a replacement token without revoking its predecessor before client cutover.
 * @param client - The dashboard database pool.
 * @param actor - The freshly verified human operator.
 * @param input - Current account version and replacement expiry.
 * @returns One-time replacement token material.
 */
export async function rotateAutomation(
    client: SQL,
    actor: string,
    input: { id: string; version: number; expiresAt: number | null }
) {
    return client.begin(async (transaction) => {
        await lockAccount(transaction, input.id, input.version);
        const credential = await createCredential(transaction, input.id, input.expiresAt);
        await transaction`UPDATE automation_accounts SET version = version + 1 WHERE id = ${input.id}`;
        await auditOperation(
            transaction,
            actor,
            "automation.token.created",
            credential.credentialId
        );
        return credential;
    });
}

/**
 * Replace grants, revoke a token or disable an account under optimistic concurrency.
 * @param client - The dashboard database pool.
 * @param actor - The freshly verified human operator.
 * @param input - Account identity/version and exactly one requested state change.
 * @returns Completion after the change and audit commit together.
 */
export async function changeAutomation(
    client: SQL,
    actor: string,
    input: { id: string; version: number } & (
        | { kind: "capabilities"; capabilities: Capability[] }
        | { kind: "revoke"; credentialId: string }
        | { kind: "disable" }
    )
): Promise<void> {
    await client.begin(async (transaction) => {
        await lockAccount(transaction, input.id, input.version);
        if (input.kind === "capabilities")
            await transaction`UPDATE automation_accounts SET capabilities = ${JSON.stringify(input.capabilities)}::text::jsonb WHERE id = ${input.id}`;
        else if (input.kind === "revoke") {
            const changed = await transaction<
                { id: string }[]
            >`UPDATE automation_credentials SET revoked_at = coalesce(revoked_at, now()) WHERE id = ${input.credentialId} AND account_id = ${input.id} RETURNING id`;
            if (!changed[0]) throw new OperationFailure("NOT_FOUND", "Token not found.");
        } else {
            await transaction`UPDATE automation_accounts SET disabled_at = now() WHERE id = ${input.id}`;
            await transaction`UPDATE automation_credentials SET revoked_at = coalesce(revoked_at, now()) WHERE account_id = ${input.id}`;
        }
        await transaction`UPDATE automation_accounts SET version = version + 1 WHERE id = ${input.id}`;
        await auditOperation(
            transaction,
            actor,
            `automation.${input.kind}`,
            input.kind === "revoke" ? input.credentialId : input.id
        );
    });
}
