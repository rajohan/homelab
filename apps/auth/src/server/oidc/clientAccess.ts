import type { AuthConfiguration } from "../config/configuration";

/**
 * Apply the current registered-client policy to an account's current groups.
 * @param configuration - The registered clients and their required groups.
 * @param groups - The account's current group membership.
 * @param clientId - The client requesting or retaining access.
 * @returns Whether the client is still registered and the account is eligible.
 */
export function clientAllowed(
    configuration: Pick<AuthConfiguration, "clients" | "clientGroups">,
    groups: readonly string[],
    clientId: string
): boolean {
    if (!configuration.clients.some((client) => client.client_id === clientId))
        return false;
    const required = configuration.clientGroups?.[clientId] ?? ["admins"];
    return required.some((group) => groups.includes(group));
}
