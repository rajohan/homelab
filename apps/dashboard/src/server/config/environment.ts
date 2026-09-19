import { isIP } from "node:net";

import type { ApplicationTarget } from "../integrations/applications/configuration";
import { parseDashboardAuthConfiguration } from "./auth";
import { parseOperationsConfiguration } from "./operations";

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

/**
 * Read scoped operation configuration at the process environment boundary.
 * @returns Validated operation settings, or undefined before provisioning.
 */
export function dashboardOperationsConfiguration() {
    return parseOperationsConfiguration(process.env);
}

/**
 * Resolve only the configured worker TLS references when an executor opens its transport.
 * @param target - Validated Docker target containing secret names, not values.
 * @returns The referenced credential values; callers must never persist or serialize them.
 */
export function applicationClientEnvironment(
    target: ApplicationTarget
): Readonly<Record<string, string | undefined>> {
    return Object.fromEntries(
        Object.values(target.tls ?? {}).map((name) => [name, process.env[name]])
    );
}

/**
 * Read the worker's private health listener with the same validation as the web listener.
 * @returns An explicit IP address and TCP port, defaulting to loopback only.
 */
export function workerHealthBinding() {
    return dashboardBindOptions({
        HOMELAB_DASHBOARD_HOST: process.env.HOMELAB_DASHBOARD_WORKER_HOST ?? "127.0.0.1",
        HOMELAB_DASHBOARD_PORT: process.env.HOMELAB_DASHBOARD_WORKER_PORT ?? "3112",
    });
}
