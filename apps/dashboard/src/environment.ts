import { isIP } from "node:net";

import { parseDashboardAuthConfiguration } from "./authConfiguration";

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

export function dashboardDevelopment(): boolean {
    return process.env.NODE_ENV !== "production";
}

export function dashboardAuthConfiguration() {
    return parseDashboardAuthConfiguration(process.env);
}
