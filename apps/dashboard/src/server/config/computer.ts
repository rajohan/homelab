import { isIP } from "node:net";

/**
 * Require an exact private IPv4 address for the separate machine listener.
 * @param hostname - Loopback, RFC1918 or Meshnet CGNAT address; wildcard/public/IPv6 binds are rejected.
 * @returns The validated address. Routing and firewall restrictions still belong to deployment.
 */
export function privateComputerAddress(hostname: string): string {
    const [a, b] = hostname.split(".").map(Number);
    if (
        isIP(hostname) !== 4 ||
        !(
            a === 127 ||
            a === 10 ||
            (a === 172 && b! >= 16 && b! <= 31) ||
            (a === 192 && b === 168) ||
            (a === 100 && b! >= 64 && b! <= 127)
        )
    )
        throw new Error(
            "Computer connections require an exact private IPv4 listener address."
        );
    return hostname;
}

/**
 * Parse the optional machine listener, disabled unless both private address and port are explicit.
 * @param environment - Scoped deployment values, supplied by the environment boundary.
 * @returns Private listener options or undefined when computer connectivity is disabled.
 */
export function parseComputerBinding(
    environment: Readonly<Record<string, string | undefined>>
): { hostname: string; port: number } | undefined {
    const hostname = environment.HOMELAB_MIRA_COMPUTER_HOST;
    const port = environment.HOMELAB_MIRA_COMPUTER_PORT;
    if (!hostname && !port) return undefined;
    if (!hostname || !port || !/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65_535)
        throw new Error("Set both a private computer listener address and a valid port.");
    return { hostname: privateComputerAddress(hostname), port: Number(port) };
}
