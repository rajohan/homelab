import type { Capability } from "@homelab/contracts/operations";

import { requireCapability } from "../automation/authentication";
import type { OperationsContext } from "./context";
import { OperationFailure } from "./errors";

/**
 * Require a configured backend and a live identity with the requested capability.
 * @param context - Identity and runtime resolved at the HTTP boundary.
 * @param capability - The domain-specific permission required by the procedure.
 * @returns Authenticated identity and scoped operation services.
 */
export function authorizedOperations(context: OperationsContext, capability: Capability) {
    if (!context.principal)
        throw new OperationFailure("UNAUTHORIZED", "Sign in to continue.");
    requireCapability(context.principal, capability);
    if (!context.operations)
        throw new OperationFailure(
            "PRECONDITION_FAILED",
            "Dashboard operations have not been configured."
        );
    return { operations: context.operations, principal: context.principal };
}

/**
 * Recheck recent human MFA before administering machine identities.
 * @param context - The request-bound central identity verifier and runtime.
 * @returns The current human actor and operational database.
 */
export async function authorizeAutomationAdministration(context: OperationsContext) {
    if (
        context.principal?.kind !== "human" ||
        !context.verifyHuman ||
        !context.operations
    )
        throw new OperationFailure(
            "FORBIDDEN",
            "Only a verified operator can manage automation access."
        );
    const current = await context.verifyHuman();
    if (current.kind !== "human" || current.id !== context.principal.id)
        throw new OperationFailure("UNAUTHORIZED", "The signed-in account changed.");
    return { client: context.operations.client, actor: `human:${current.id}` };
}
