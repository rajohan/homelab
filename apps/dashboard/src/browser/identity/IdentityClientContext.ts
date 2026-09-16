import type { IdentityClient } from "@homelab/ui/identity/client";
import { createContext, useContext } from "react";

export const IdentityClientContext = createContext<IdentityClient | undefined>(undefined);

/**
 * Read the dashboard identity client owned by the enclosing session boundary.
 * @returns The shared client for account actions and session-change cancellation.
 * @throws {Error} Settings is rendered outside its identity boundary.
 */
export function useIdentityClient(): IdentityClient {
    const client = useContext(IdentityClientContext);
    if (!client) throw new Error("IdentityBoundary is required for account settings.");
    return client;
}
