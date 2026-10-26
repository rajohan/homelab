import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import type * as NativeSdk from "@trycua/cua-driver";

import { serveComputerChild } from "./child";
import { openNativeComputerWindow } from "./native";
import { computerDriverVersion } from "./policy";

const loadSdk = () =>
    import(
        pathToFileURL(
            path.join(
                path.dirname(process.execPath),
                "node_modules/@trycua/cua-driver/dist/index.js"
            )
        ).href
    ) as Promise<typeof NativeSdk>;

/**
 * Run the fixed native worker protocol or its noninteractive metadata qualification.
 * @param args - No arguments for the private protocol, or the single fixed runtime check.
 * @returns Completion after protocol retirement or a bounded metadata check.
 */
export async function runComputerWorker(args: readonly string[]): Promise<void> {
    if (args.length === 0) {
        await serveComputerChild(process.stdin, process.stdout, (grant) =>
            openNativeComputerWindow(grant, loadSdk)
        );
    } else if (args.length === 1 && args[0] === "--check-runtime") {
        // Fixed state-only qualification: load the native module and read metadata, never a screen or app.
        const sdk = await loadSdk();
        const temporary = await mkdtemp(path.join(tmpdir(), "mira-worker-check-"));
        let driver: ReturnType<typeof sdk.CuaDriver.createConfigured> | undefined;
        try {
            const manifest = path.join(temporary, "capabilities.json");
            await writeFile(
                manifest,
                JSON.stringify({
                    version: 3,
                    expires_after: "1m",
                    idle_timeout: "1m",
                    allow: { tools: ["get_session_state"] },
                    resources: { apps: [], desktop: { display: false } },
                })
            );
            driver = sdk.CuaDriver.createConfigured({
                claudeCodeCompatibility: false,
                authorization: {
                    allowedModes: [sdk.SessionPermissionMode.Bounded],
                    compatibilityMode: sdk.SessionPermissionMode.Bounded,
                    compatibilityCapabilityManifestPath: manifest,
                    unrestrictedAcknowledged: false,
                    maxSessionTtlSeconds: 60n,
                    maxIdleTtlSeconds: 60n,
                },
            });
            const metadata = await driver.metadata();
            if (metadata.driverVersion !== computerDriverVersion || !metadata.embedded)
                throw new Error("Unexpected packaged computer driver.");
            process.stdout.write(
                JSON.stringify({
                    driver: metadata.driverVersion,
                    embedded: true,
                    bun: Bun.version,
                }) + "\n"
            );
        } finally {
            await driver?.shutdown();
            await rm(temporary, { recursive: true, force: true });
        }
    } else throw new Error("The computer worker accepts no command arguments.");
}

if (import.meta.main) await runComputerWorker(process.argv.slice(2));
