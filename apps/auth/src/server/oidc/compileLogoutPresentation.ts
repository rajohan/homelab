import { fileURLToPath } from "node:url";

import type { LogoutStep } from "./LogoutView";

export interface LogoutPresentation {
    style: string;
    views: Record<LogoutStep, { title: string; markup: string }>;
}

/**
 * Build the shared Auth views and styles for the independent provider response.
 * @returns The CSS and HTML emitted by the local presentation build script.
 */
export function compileLogoutPresentation(): LogoutPresentation {
    const script = fileURLToPath(new URL("buildLogoutPresentation.ts", import.meta.url));
    const result = Bun.spawnSync([process.execPath, script]);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return JSON.parse(result.stdout.toString()) as LogoutPresentation;
}
