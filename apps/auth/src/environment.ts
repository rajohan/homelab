import { isIP } from "node:net";

import { parseAuthConfiguration } from "./configuration";

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

export function authConfiguration() {
    return parseAuthConfiguration(process.env);
}
export function authDevelopment(): boolean {
    return process.env.NODE_ENV !== "production";
}
