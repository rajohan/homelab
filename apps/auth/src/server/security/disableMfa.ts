import { eq } from "drizzle-orm";

import { challenges, factors, recoveryCodes } from "../database/schema";
import type { Accounts, Principal } from "./accounts";
import { invalidProof } from "./errors";
import { audit, rateLimit } from "./store";

/**
 * Remove all second factors only after fresh proof and current-password verification.
 * @param accounts - The account service handling transactional identity and logout.
 * @param principal - The authenticated initiating session.
 * @param password - The current password, checked without storing or logging it.
 * @returns Completion after factors, recovery proofs and every session are invalidated atomically.
 */
export async function disableMfa(
    accounts: Accounts,
    principal: Principal,
    password: string
): Promise<void> {
    await accounts.requireFresh(principal);
    await rateLimit(accounts.database, `disable-mfa:${principal.user.id}`, 5, 300_000);
    if (!(await accounts.checkPassword(password, principal.user.passwordHash)))
        invalidProof();
    await accounts.protectedAction(principal, async (transaction, current) => {
        if (current.user.passwordHash !== principal.user.passwordHash) invalidProof();
        await transaction.delete(factors).where(eq(factors.userId, current.user.id));
        await transaction
            .delete(recoveryCodes)
            .where(eq(recoveryCodes.userId, current.user.id));
        await transaction
            .delete(challenges)
            .where(eq(challenges.userId, current.user.id));
        await accounts.revokeOthers(transaction, current);
        await accounts.revoke(transaction, current.session.id);
        await audit(transaction, current.user.id, "mfa_disabled");
    });
}
