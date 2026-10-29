import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as v from "valibot";

import { buildWindowsConsent } from "./buildWindowsConsent";

/**
 * Qualify the actual consent UI/pipe and lock transition on a disposable hosted Windows desktop.
 * @returns Content-free evidence after owned fixture cleanup; the runner remains locked.
 */
export async function testWindowsConsentAcceptance() {
    if (
        process.platform !== "win32" ||
        process.env.GITHUB_ACTIONS !== "true" ||
        process.env.RUNNER_ENVIRONMENT !== "github-hosted" ||
        process.env.RUNNER_OS !== "Windows"
    )
        throw new Error("Consent acceptance requires disposable hosted Windows.");
    const parent = await realpath(tmpdir());
    const directory = await realpath(
        await mkdtemp(path.join(parent, "mira-consent-acceptance-"))
    );
    if (
        path.dirname(directory) !== parent ||
        !path.basename(directory).startsWith("mira-consent-acceptance-")
    )
        throw new Error("Unexpected acceptance directory.");
    try {
        const { host } = await buildWindowsConsent(directory);
        const root = fileURLToPath(new URL("..", import.meta.url));
        const source = path.join(root, "apps/mira/native/windows");
        const system = process.env.SystemRoot ?? process.env.SYSTEMROOT;
        if (!system || !path.isAbsolute(system))
            throw new Error("Windows root is missing.");
        const framework = path.join(system, "Microsoft.NET/Framework64/v4.0.30319");
        const compiler = path.join(framework, "csc.exe");
        const fixture = path.join(directory, "mira-consent-fixture.exe");
        const checks = path.join(directory, "mira-consent-acceptance.exe");
        const common = [
            "/nologo",
            "/platform:x64",
            "/warnaserror+",
            "/optimize+",
            `/win32manifest:${path.join(source, "app.manifest")}`,
            "/reference:System.Windows.Forms.dll",
            "/reference:System.Drawing.dll",
            "/reference:System.Web.Extensions.dll",
            path.join(source, "ConsentProtocol.cs"),
        ];
        for (const args of [
            [
                "/target:winexe",
                `/out:${fixture}`,
                ...common,
                path.join(source, "tests/InputFixture.cs"),
            ],
            [
                "/target:exe",
                `/out:${checks}`,
                ...common,
                `/reference:${path.join(framework, "WPF/UIAutomationClient.dll")}`,
                `/reference:${path.join(framework, "WPF/UIAutomationTypes.dll")}`,
                `/reference:${path.join(framework, "WPF/WindowsBase.dll")}`,
                path.join(source, "NativeWindows.cs"),
                path.join(source, "tests/ConsentAcceptance.cs"),
                path.join(source, "tests/AcceptanceToken.cs"),
                path.join(source, "tests/AcceptanceAccount.cs"),
                path.join(source, "tests/AcceptanceDesktop.cs"),
            ],
        ])
            execFileSync(compiler, args, {
                windowsHide: true,
                timeout: 30_000,
                maxBuffer: 64 * 1024,
            });
        const receipt = execFileSync(checks, [host, fixture], {
            windowsHide: true,
            timeout: 90_000,
            maxBuffer: 64 * 1024,
            encoding: "utf8",
        });
        return v.parse(
            v.strictObject({
                windowsConsentAcceptance: v.literal("passed"),
                localStop: v.literal(true),
                parentLoss: v.literal(true),
                targetExit: v.literal(true),
                locked: v.literal(true),
                lockedStartupDenied: v.literal(true),
            }),
            JSON.parse(receipt) as unknown
        );
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}
if (import.meta.main) console.info(await testWindowsConsentAcceptance());
