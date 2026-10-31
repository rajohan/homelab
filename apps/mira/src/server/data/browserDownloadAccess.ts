import type { miraBrowserHumanOperationSchema } from "@homelab/contracts/miraBrowser";
import type { TransactionSQL } from "bun";
import type * as v from "valibot";

import { readBrowserAccess } from "./browserAccess";
import { MiraFailure } from "./context";

type Operation = v.InferOutput<typeof miraBrowserHumanOperationSchema>;

/**
 * Recheck the human's confirmed download source without granting model or multi-origin authority.
 * @param query - Transaction holding the owning account's control lock.
 * @param owner - Account bound by the endpoint or trusted host claim.
 * @param id - Exact active browser grant.
 * @param operation - Parsed operator command with the confirmed display filename and origin.
 * @returns Completion only while the same single-origin control grant is available.
 */
export async function requireBrowserDownload(
    query: TransactionSQL,
    owner: string,
    id: string,
    operation: Operation
): Promise<void> {
    if (operation.method !== "download")
        throw new Error("Expected a confirmed download.");
    const access = await readBrowserAccess(query, owner, id);
    if (
        !access?.available ||
        access.state !== "active" ||
        access.controller !== "human" ||
        access.mode !== "control" ||
        access.policy?.origins.length !== 1 ||
        access.policy.origins[0] !== operation.origin
    )
        throw new MiraFailure(
            "FORBIDDEN",
            "The confirmed download website is no longer available."
        );
}
