import { mkdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

import { sandboxProfileEnvironment } from "../config/environment";
import {
    daytonaCheckProfile,
    daytonaSandboxSchema,
    parseDaytonaArguments,
    type DaytonaSandboxRequest,
} from "./profile";
import { executeDaytonaChecks } from "./workflow";

/** Verify the fixed image and non-root process before creating any attempt files. */
export async function requireSandboxImage(): Promise<void> {
    if (
        process.platform !== "linux" ||
        process.getuid?.() === 0 ||
        sandboxProfileEnvironment() !== "homelab-check-v2" ||
        Bun.version !== daytonaCheckProfile.bunVersion
    )
        throw new Error(
            "This command requires the qualified non-root Homelab Daytona snapshot."
        );
    const profile = await readFile("/opt/homelab/profile.json", "utf8");
    if (profile.trim() !== JSON.stringify(daytonaCheckProfile))
        throw new Error("Sandbox profile does not match this harness.");
}

/**
 * Run the fixed public Homelab checks inside a qualified disposable Linux snapshot.
 * @param request - Exact attempt, commit and optional reviewed patch fingerprint.
 * @param stopping - Sandbox process interruption; does not imply cloud-resource deletion.
 * @param announce - Status sink; the local JSON transport suppresses ordinary stdout messages.
 * @returns Nonzero when preparation, any required check, result recovery or local database cleanup fails.
 */
export async function runDaytonaChecks(
    request: DaytonaSandboxRequest,
    stopping: AbortSignal,
    announce?: (message: string) => void
): Promise<number> {
    const input = v.parse(daytonaSandboxSchema, request);
    await requireSandboxImage();
    const root = "/tmp/homelab-mira";
    await mkdir(root, { recursive: true, mode: 0o700 });
    if ((await realpath(root)) !== root)
        throw new Error("Sandbox root is not canonical.");
    const attempt = path.join(root, input.id);
    await mkdir(attempt, { recursive: true, mode: 0o700 });
    if ((await realpath(attempt)) !== attempt)
        throw new Error("Sandbox attempt is not canonical.");
    return executeDaytonaChecks(input, attempt, stopping, undefined, announce);
}

/**
 * Run the snapshot entry point with strict positional arguments and no environment discovery.
 * @returns Completion with the check result as process exit status.
 */
export async function main(): Promise<void> {
    const input = parseDaytonaArguments(process.argv.slice(2));
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    try {
        process.exitCode = await runDaytonaChecks(input, controller.signal);
    } finally {
        process.off("SIGTERM", stop);
        process.off("SIGINT", stop);
    }
}
if (import.meta.main) await main();
