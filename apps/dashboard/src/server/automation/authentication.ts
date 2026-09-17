import { capabilitySchema, type Capability } from "@homelab/contracts/operations";
import type { SQL } from "bun";
import * as v from "valibot";

import { OperationFailure } from "../operations/errors";
import { digestAutomationToken, sameTokenDigest } from "./tokens";

export interface OperationPrincipal {
    readonly kind: "human" | "automation";
    readonly id: string;
    readonly capabilities: readonly Capability[];
}

/**
 * Resolve a machine token against live account state with a per-account request budget.
 * @param client - The dashboard database pool.
 * @param authorization - The complete Authorization header.
 * @returns A current, least-privilege machine principal.
 */
export async function authenticateAutomation(
    client: SQL,
    authorization: string
): Promise<OperationPrincipal> {
    const match = /^Bearer (hlb_([a-f0-9-]{36})\.[A-Za-z0-9_-]{43})$/.exec(authorization);
    if (!match?.[1] || !match[2])
        throw new OperationFailure(
            "UNAUTHORIZED",
            "A valid automation token is required."
        );
    const token = match[1],
        prefix = match[2];
    return client.begin(async (transaction) => {
        const rows = await transaction<
            { id: string; account_id: string; digest: string; capabilities: unknown }[]
        >`SELECT c.id, c.account_id, c.digest, a.capabilities FROM automation_credentials c JOIN automation_accounts a ON a.id = c.account_id WHERE c.prefix = ${prefix} AND c.revoked_at IS NULL AND (c.expires_at IS NULL OR c.expires_at > now()) AND a.disabled_at IS NULL`;
        const credential = rows[0];
        const matches = sameTokenDigest(
            digestAutomationToken(token),
            credential?.digest ?? "0".repeat(64)
        );
        if (!credential || !matches)
            throw new OperationFailure(
                "UNAUTHORIZED",
                "A valid automation token is required."
            );
        const budget = await transaction<
            { count: number }[]
        >`INSERT INTO operation_rate_windows (key, count, expires_at) VALUES (${credential.account_id}, 1, now() + interval '1 minute') ON CONFLICT (key) DO UPDATE SET count = CASE WHEN operation_rate_windows.expires_at <= now() THEN 1 ELSE operation_rate_windows.count + 1 END, expires_at = CASE WHEN operation_rate_windows.expires_at <= now() THEN now() + interval '1 minute' ELSE operation_rate_windows.expires_at END RETURNING count`;
        if ((budget[0]?.count ?? 121) > 120)
            throw new OperationFailure(
                "TOO_MANY_REQUESTS",
                "Automation request limit reached."
            );
        await transaction`UPDATE automation_credentials SET last_used_at = now() WHERE id = ${credential.id} AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')`;
        return {
            kind: "automation",
            id: credential.account_id,
            capabilities: v.parse(v.array(capabilitySchema), credential.capabilities),
        };
    });
}

/**
 * Deny missing capabilities before any domain query or mutation runs.
 * @param principal - The server-verified request identity.
 * @param capability - The permission required by this operation.
 */
export function requireCapability(
    principal: OperationPrincipal,
    capability: Capability
): void {
    if (!principal.capabilities.includes(capability))
        throw new OperationFailure(
            "FORBIDDEN",
            "This account does not have permission for this action."
        );
}
