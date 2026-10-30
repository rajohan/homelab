import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

import * as v from "valibot";

import { launchBrowserDriver, type BrowserDriverHost } from "./driverProcess";
import pin from "./driverRelease.json";
import type { BrowserNativeResult } from "./protocol";

export const browserDriverVersion = pin.version;
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

const initializeSchema = v.object({
    protocolVersion: v.literal("2025-06-18"),
    serverInfo: v.object({ version: v.literal(browserDriverVersion) }),
    capabilities: v.object({ tools: v.object({}) }),
});
const resultSchema = v.object({
    isError: v.optional(v.boolean(), false),
    structuredContent: v.optional(v.unknown()),
    content: v.pipe(
        v.array(
            v.union([
                v.object({ type: v.literal("text"), text: v.string() }),
                v.object({
                    type: v.literal("image"),
                    mimeType: v.literal("image/png"),
                    data: v.string(),
                }),
            ])
        ),
        v.maxLength(16)
    ),
});

/**
 * Start the pinned official CLI with one approved bounded manifest and a private MCP socket.
 * @param manifest - Host-written capability file inside the session directory.
 * @param directory - Private canonical session directory, removed only after shutdown.
 * @param signal - Startup cancellation; after startup the native owner closes after saving its profile.
 * @param launch - Official process host; synthetic replacement is for unit tests only.
 * @returns A browser-only transport with no unrestricted, standalone or SDK fallback.
 */
export async function openBrowserDriver(
    manifest: string,
    directory: string,
    signal: AbortSignal,
    launch = launchBrowserDriver
): Promise<BrowserDriver> {
    signal.throwIfAborted();
    const policy = v.parse(
        v.object({ allow: v.object({ tools: v.array(v.string()) }) }),
        JSON.parse(await readFile(manifest, "utf8"))
    );
    const allowed = new Set(policy.allow.tools);
    const session = randomUUID();
    const host = await launch(manifest, directory);
    let connection: ReturnType<BrowserDriverHost["connect"]> | undefined;
    let closing: Promise<void> | undefined;
    let stopped = false;
    let started = false;
    const onAbort = () => {
        void connection?.close().catch(() => {});
        void shutdown().catch(() => {});
    };
    async function shutdown() {
        stopped = true;
        closing ??= (async () => {
            await Promise.resolve();
            signal.removeEventListener("abort", onAbort);
            host.signal.removeEventListener("abort", onAbort);
            connection?.signal.removeEventListener("abort", onAbort);
            try {
                if (connection && started && !connection.signal.aborted) {
                    const result = normalizeBrowserResult(
                        await connection.request("tools/call", {
                            name: "end_session",
                            arguments: { session },
                        })
                    );
                    if (result.isError)
                        throw new Error("Browser session cleanup was refused.");
                }
            } finally {
                try {
                    await connection?.close();
                } finally {
                    await host.stop();
                }
            }
            return;
        })();
        return closing;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    host.signal.addEventListener("abort", onAbort, { once: true });
    const check = () => {
        signal.throwIfAborted();
        if (stopped || host.signal.aborted) throw new Error("Browser driver stopped.");
    };
    const callTool: BrowserDriver["callTool"] = async (name, args, operation) => {
        operation.throwIfAborted();
        check();
        if (
            !allowed.has(name) ||
            name === "start_session" ||
            name === "end_session" ||
            Object.keys(args).some((key) => key.startsWith("_") || key === "session")
        )
            throw new Error("Browser tool is outside the approved manifest.");
        const cancelled = onAbort;
        operation.addEventListener("abort", cancelled, { once: true });
        try {
            const result = normalizeBrowserResult(
                await connection!.request("tools/call", {
                    name,
                    arguments: { ...args, session },
                })
            );
            operation.throwIfAborted();
            check();
            return result;
        } finally {
            operation.removeEventListener("abort", cancelled);
        }
    };
    try {
        await host.ready(signal);
        check();
        connection = host.connect();
        connection.signal.addEventListener("abort", onAbort, { once: true });
        v.parse(
            initializeSchema,
            await connection.request("initialize", {
                protocolVersion: "2025-06-18",
                capabilities: {},
                clientInfo: { name: "homelab-browser", version: "1" },
            })
        );
        connection.notify("notifications/initialized", {});
        const start = normalizeBrowserResult(
            await connection.request("tools/call", {
                name: "start_session",
                arguments: { session },
            })
        );
        if (start.isError) throw new Error("The bounded browser session was refused.");
        started = true;
        check();
        signal.removeEventListener("abort", onAbort);
        return { callTool, shutdown };
    } catch (error) {
        await shutdown();
        throw error;
    }
}

/**
 * Keep only the official structured result and PNG content from an MCP tool response.
 * @param input - Untrusted bounded MCP result; textual diagnostics are never forwarded.
 * @returns The browser protocol's validated result envelope.
 */
export function normalizeBrowserResult(input: unknown): BrowserNativeResult {
    const result = v.parse(resultSchema, input);
    const structuredJson =
        result.structuredContent === undefined
            ? undefined
            : JSON.stringify(result.structuredContent);
    if (structuredJson && Buffer.byteLength(structuredJson) > 256 * 1024)
        throw new Error("Browser metadata exceeds its size limit.");
    return {
        isError: result.isError,
        ...(structuredJson === undefined ? {} : { structuredJson }),
        images: result.content
            .filter((item) => item.type === "image")
            .map((item) => ({ mimeType: item.mimeType, dataBase64: item.data })),
    };
}
