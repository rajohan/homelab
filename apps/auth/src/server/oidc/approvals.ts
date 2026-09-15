import { and, eq, sql } from "drizzle-orm";
import type { ClientMetadata } from "oidc-provider";

import type { AuthStore } from "../database/connection";
import { grantSessions, oidcApprovals } from "../database/schema";
import type { Accounts, Principal } from "../security/accounts";
import { tokenDigest } from "../security/crypto";
import { audit } from "../security/store";
import { revokeBoundGrants } from "./logout";

function fingerprint(client: ClientMetadata): string {
    // A credential rotation is not a new recipient. Names and destinations are.
    return tokenDigest(
        JSON.stringify({
            id: client.client_id,
            name: client.client_name,
            redirects: [...(client.redirect_uris ?? [])].toSorted(),
            logoutRedirects: [...(client.post_logout_redirect_uris ?? [])].toSorted(),
            backchannel: client.backchannel_logout_uri ?? null,
        })
    );
}

/**
 * Check a remembered user decision without treating client registration as approval.
 * @param store - The database or caller's account-locked transaction.
 * @param userId - The authenticated account owning the decision.
 * @param client - The current registered recipient.
 * @param scope - The exact requested, provider-validated scopes.
 * @returns Whether this recipient and every requested permission were approved.
 */
export async function hasClientApproval(
    store: AuthStore,
    userId: string,
    client: ClientMetadata,
    scope: string
): Promise<boolean> {
    const [approval] = await store
        .select()
        .from(oidcApprovals)
        .where(
            and(
                eq(oidcApprovals.userId, userId),
                eq(oidcApprovals.clientId, client.client_id)
            )
        );
    return (
        approval?.fingerprint === fingerprint(client) &&
        scope
            .split(" ")
            .filter(Boolean)
            .every((value) => approval.scopes.includes(value))
    );
}

/**
 * Remember an explicit decision in the same account-locked transaction as its new grant.
 * @param store - The caller's transaction after authentication and account locking.
 * @param userId - The account that approved the displayed request.
 * @param client - The registered recipient shown in the request.
 * @param scope - Only the permissions from that request, never browser-supplied scopes.
 * @returns Completion after recording or extending the user's approval.
 */
export async function rememberClientApproval(
    store: AuthStore,
    userId: string,
    client: ClientMetadata,
    scope: string
): Promise<void> {
    const recipient = fingerprint(client);
    const [previous] = await store
        .select()
        .from(oidcApprovals)
        .where(
            and(
                eq(oidcApprovals.userId, userId),
                eq(oidcApprovals.clientId, client.client_id)
            )
        );
    const value = {
        userId,
        clientId: client.client_id,
        clientName: client.client_name ?? client.client_id,
        fingerprint: recipient,
        scopes: [
            ...new Set([
                ...(previous?.fingerprint === recipient ? previous.scopes : []),
                ...scope.split(" ").filter(Boolean),
            ]),
        ].toSorted(),
        approvedAt: new Date(),
    };
    await store
        .insert(oidcApprovals)
        .values(value)
        .onConflictDoUpdate({
            target: [oidcApprovals.userId, oidcApprovals.clientId],
            set: value,
        });
    await audit(store, userId, "application_access_approved");
}

/**
 * Revoke a remembered approval and all of its session-bound protocol grants.
 * @param accounts - The account security service enforcing step-up and account locking.
 * @param principal - The account requesting revocation.
 * @param clientId - The selected app identifier; other users and apps remain unchanged.
 * @returns Completion after approval removal, token revocation and logout queueing.
 */
export async function revokeClientApproval(
    accounts: Accounts,
    principal: Principal,
    clientId: string
): Promise<void> {
    await accounts.protectedAction(principal, async (transaction) => {
        await transaction
            .delete(oidcApprovals)
            .where(
                and(
                    eq(oidcApprovals.userId, principal.user.id),
                    eq(oidcApprovals.clientId, clientId)
                )
            );
        await revokeBoundGrants(
            transaction,
            sql`${grantSessions.userId} = ${principal.user.id} AND ${grantSessions.clientId} = ${clientId}`
        );
        await audit(transaction, principal.user.id, "application_access_revoked");
    });
}
