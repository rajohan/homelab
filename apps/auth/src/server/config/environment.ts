import { isIP } from "node:net";

import { type AuthConfiguration, parseAuthConfiguration } from "./configuration";
import { loadAccessPolicy } from "./policyFile";

/**
 * Validate the identity listener address and port.
 * @param environment - Environment values; defaults to the current process.
 * @returns The listener IP and numeric TCP port.
 * @throws {Error} The host is not an IP address or the port is invalid.
 */
export function authBindOptions(
    environment: Readonly<Record<string, string | undefined>> = process.env
): { hostname: string; port: number } {
    const hostname = environment.HOMELAB_AUTH_HOST ?? "127.0.0.1";
    const rawPort = environment.HOMELAB_AUTH_PORT ?? "3101";
    if (isIP(hostname) === 0) throw new Error("HOMELAB_AUTH_HOST must be an IP address");
    if (!/^[1-9]\d{0,4}$/.test(rawPort) || Number(rawPort) > 65_535) {
        throw new Error("HOMELAB_AUTH_PORT must be between 1 and 65535");
    }
    return { hostname, port: Number(rawPort) };
}

/**
 * Load the deployment access policy and validate scoped identity settings.
 * @param environment - Identity-service environment values; defaults to the current process.
 * @returns Validated settings, or undefined for the visual-only development shell.
 */
export async function authConfiguration(
    environment: Readonly<Record<string, string | undefined>> = process.env
): Promise<AuthConfiguration | undefined> {
    // The visual-only development shell does not load a deployment policy.
    if (!environment.HOMELAB_AUTH_ISSUER) return parseAuthConfiguration(environment);
    return parseAuthConfiguration(
        environment,
        await loadAccessPolicy(environment.HOMELAB_AUTH_POLICY_FILE)
    );
}
/**
 * Read whether the auth app runs outside production.
 * @returns Whether development behavior is enabled.
 */
export function authDevelopment(): boolean {
    return process.env.NODE_ENV !== "production";
}
