import { isIP } from "node:net";

import { parseDashboardAuthConfiguration } from "./auth";

/**
 * Validate the dashboard listener address and port.
 * @param environment - Environment values; defaults to the current process.
 * @returns The listener IP and numeric TCP port.
 * @throws {Error} The host is not an IP address or the port is outside the supported range.
 */
export function dashboardBindOptions(
    environment: Readonly<Record<string, string | undefined>> = process.env
): { hostname: string; port: number } {
    const hostname = environment.HOMELAB_DASHBOARD_HOST ?? "127.0.0.1";
    const rawPort = environment.HOMELAB_DASHBOARD_PORT ?? "3100";
    if (isIP(hostname) === 0)
        throw new Error("HOMELAB_DASHBOARD_HOST must be an IP address");
    if (!/^[1-9]\d{0,4}$/.test(rawPort) || Number(rawPort) > 65_535) {
        throw new Error("HOMELAB_DASHBOARD_PORT must be between 1 and 65535");
    }
    return { hostname, port: Number(rawPort) };
}

/**
 * Read whether the dashboard runs outside production.
 * @returns Whether development behavior is enabled.
 */
export function dashboardDevelopment(): boolean {
    return process.env.NODE_ENV !== "production";
}

/**
 * Parse the dashboard identity settings from the process environment.
 * @returns Validated identity settings, or undefined for an unconfigured development shell.
 */
export function dashboardAuthConfiguration() {
    return parseDashboardAuthConfiguration(process.env);
}
