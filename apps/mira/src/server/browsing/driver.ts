import { randomUUID } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import * as v from "valibot";

import { dependencies } from "../../../../../package.json";
import type { BrowserNativeResult } from "./protocol";

export const browserDriverVersion = dependencies["@trycua/cua-driver"];
export interface BrowserDriver {
    callTool: (
        name: string,
        args: Record<string, unknown>,
        signal: AbortSignal
    ) => Promise<BrowserNativeResult>;
    shutdown: () => Promise<void>;
}
export type BrowserDriverFactory = (
    manifest: string,
    directory: string,
    signal: AbortSignal
) => Promise<BrowserDriver>;
const resultSchema = v.object({
    isError: v.boolean(),
    structuredJson: v.exactOptional(v.pipe(v.string(), v.maxLength(256 * 1024))),
    images: v.pipe(
        v.array(v.object({ mimeType: v.literal("image/png"), dataBase64: v.string() })),
        v.maxLength(16)
    ),
});

/**
 * Open the package-managed native SDK with the host's browser capability manifest.
 * @param manifest - Host-written capability file inside the private session directory.
 * @param directory - Canonical session directory, removed after shutdown.
 * @param signal - Startup cancellation; the browser owner closes the SDK before saving resources.
 * @returns One browser-only session using the same supported SDK as Windows.
 */
export async function openBrowserDriver(
    manifest: string,
    directory: string,
    signal: AbortSignal
): Promise<BrowserDriver> {
    signal.throwIfAborted();
    if (
        (await realpath(directory)) !== directory ||
        manifest !== path.join(directory, "capabilities.json")
    )
        throw new Error("The browser driver requires its private session directory.");
    const policy = v.parse(
        v.object({ allow: v.object({ tools: v.array(v.string()) }) }),
        JSON.parse(await readFile(manifest, "utf8"))
    );
    const allowed = new Set(policy.allow.tools);
    const sdk = await import("@trycua/cua-driver");
    const native = sdk.CuaDriver.createConfigured({
        claudeCodeCompatibility: false,
        authorization: {
            allowedModes: [sdk.SessionPermissionMode.Bounded],
            compatibilityMode: sdk.SessionPermissionMode.Bounded,
            compatibilityCapabilityManifestPath: manifest,
            unrestrictedAcknowledged: false,
            maxSessionTtlSeconds: 300n,
            maxIdleTtlSeconds: 60n,
        },
    });
    const session = randomUUID();
    let closing: Promise<void> | undefined;
    const shutdown = () => {
        closing ??= native.shutdown().finally(() => {
            if (sdk.CuaDriver.instanceOf(native)) native.uniffiDestroy();
        });
        return closing;
    };
    const abort = () => {
        void shutdown().catch(() => {});
    };
    signal.addEventListener("abort", abort, { once: true });
    try {
        const metadata = await native.metadata();
        if (metadata.driverVersion !== browserDriverVersion || !metadata.embedded)
            throw new Error("Unexpected browser driver runtime.");
        await native.startSession(sdk.StartSessionInput.new({ session }), { signal });
        signal.throwIfAborted();
        return {
            callTool: async (name, args, operation) => {
                operation.throwIfAborted();
                if (
                    closing ||
                    !allowed.has(name) ||
                    ["start_session", "end_session"].includes(name) ||
                    Object.keys(args).some(
                        (key) => key.startsWith("_") || key === "session"
                    )
                )
                    throw new Error("Browser tool is outside this session's manifest.");
                operation.addEventListener("abort", abort, { once: true });
                try {
                    const result = await native.callTool(
                        name,
                        JSON.stringify({ ...args, session }),
                        { signal: operation }
                    );
                    operation.throwIfAborted();
                    if (closing) throw new Error("Browser driver stopped.");
                    return v.parse(resultSchema, result);
                } finally {
                    operation.removeEventListener("abort", abort);
                }
            },
            shutdown,
        };
    } catch (error) {
        await shutdown();
        throw error;
    } finally {
        signal.removeEventListener("abort", abort);
    }
}
