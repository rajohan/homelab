import { execFileSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as v from "valibot";

import { ComputerLocalConsentHost } from "../computer/localConsentHost";
import { openWindowsComputerProcess } from "../computer/process";
import { ComputerWindowSession } from "../computer/session";
import {
    computerEnvironment,
    hostedComputerQualificationEnvironment,
} from "../config/environment";
import { RpcProcess } from "../runtime/rpcProcess";

const point = v.strictObject({ x: v.number(), y: v.number() });
const stateSchema = v.strictObject({
    pid: v.pipe(v.number(), v.integer(), v.minValue(1)),
    executable: v.string(),
    startedAt: v.pipe(v.string(), v.regex(/^[1-9][0-9]*$/)),
    windowId: v.pipe(v.string(), v.regex(/^[1-9][0-9]*$/)),
    title: v.literal("Mira isolated Windows input fixture"),
    text: v.string(),
    count: v.number(),
    width: v.number(),
    height: v.number(),
    entry: point,
    button: point,
});

/**
 * Qualify the extracted native worker against its own fixture on a disposable hosted Windows runner.
 * @param directory - The extracted, already inventory-verified companion package.
 * @param root - Caller-owned temporary qualification directory, separate from release contents.
 * @returns A content-free receipt after capture, text, click, scope, replay and process cleanup checks.
 */
export async function qualifyWindowsInput(directory: string, root: string) {
    if (process.platform !== "win32" || !hostedComputerQualificationEnvironment())
        throw new Error("Native input qualification requires disposable hosted Windows.");
    if (!path.isAbsolute(directory) || !path.isAbsolute(root))
        throw new Error("Use owned absolute qualification directories.");
    const source = fileURLToPath(new URL("../../../native/windows/", import.meta.url));
    const environment = computerEnvironment();
    const system = environment.SystemRoot ?? environment.SYSTEMROOT;
    if (!system || !path.isAbsolute(system)) throw new Error("Windows root is missing.");
    const executable = path.join(root, "mira-input-fixture.exe");
    execFileSync(
        path.join(system, "Microsoft.NET/Framework64/v4.0.30319/csc.exe"),
        [
            "/nologo",
            "/platform:x64",
            "/warnaserror+",
            "/optimize+",
            "/target:winexe",
            `/out:${executable}`,
            `/win32manifest:${path.join(source, "app.manifest")}`,
            "/reference:System.Windows.Forms.dll",
            "/reference:System.Drawing.dll",
            "/reference:System.Web.Extensions.dll",
            path.join(source, "ConsentProtocol.cs"),
            path.join(source, "tests/InputFixture.cs"),
        ],
        { windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 }
    );
    const fixture = new RpcProcess({
        command: executable,
        args: [],
        cwd: root,
        env: {
            ...environment,
            GITHUB_ACTIONS: "true",
            RUNNER_ENVIRONMENT: "github-hosted",
        },
        windowsHide: false,
        stopViaStdin: true,
        requireCleanExit: true,
        requestTimeoutMs: 5000,
        maxFrameBytes: 4096,
        onRequest: () => Promise.reject(new Error("The fixture cannot request tools.")),
    });
    const readState = async () =>
        v.parse(stateSchema, await fixture.request("state", {}));
    const eventually = async (
        check: (state: v.InferOutput<typeof stateSchema>) => boolean
    ) => {
        const until = performance.now() + 3000;
        do {
            if (check(await readState())) return;
            await Bun.sleep(25);
        } while (performance.now() < until);
        throw new Error(
            "Independent Windows fixture state did not confirm native input."
        );
    };
    const signal = AbortSignal.timeout(50_000);
    try {
        const state = await readState();
        const grant = {
            executable: await realpath(executable),
            pid: state.pid,
            windowId: state.windowId,
            startedAt: state.startedAt,
            delivery: "foreground" as const,
        };
        if (
            (await realpath(state.executable)) !== grant.executable ||
            state.text !== "" ||
            state.count !== 0
        )
            throw new Error("Unexpected fixture identity or initial state.");
        const options = { directory, environment, signal };
        const view = await openWindowsComputerProcess(
            { ...grant, mode: "view" },
            options
        );
        try {
            const frame = await view.observe(signal);
            if (frame.width !== state.width || frame.height !== state.height)
                throw new Error("The captured frame does not match the fixture window.");
            await denied(() => view.click(state.button.x, state.button.y, signal));
            await denied(() => view.type("Denied text", signal));
            const untouched = await readState();
            if (untouched.text !== "" || untouched.count !== 0)
                throw new Error("View-only access changed fixture state.");
        } finally {
            await view.close();
        }
        const wrong = await openWindowsComputerProcess(
            { ...grant, executable: await realpath(process.execPath) },
            options
        );
        try {
            await denied(() => wrong.observe(signal));
        } finally {
            await wrong.close();
        }
        // Exercise the production wrapper with a test-only consent surface for this owned fixture.
        const host = new ComputerLocalConsentHost(
            {
                command: executable,
                args: [],
                cwd: root,
                environment,
                origin: "https://fixture.example.test",
            },
            (target, stopped) =>
                openWindowsComputerProcess(target, { ...options, signal: stopped }),
            ({ signal: stopped }) =>
                Promise.resolve({
                    target: { ...grant, mode: "control" as const },
                    signal: stopped,
                    assertReady: async () => {
                        signal.throwIfAborted();
                        fixture.signal.throwIfAborted();
                        const current = await readState();
                        if (
                            current.pid !== grant.pid ||
                            current.windowId !== grant.windowId ||
                            current.startedAt !== grant.startedAt
                        )
                            throw new Error("Fixture identity changed.");
                    },
                    close: () => Promise.resolve(),
                })
        );
        const target = await host.select(
            {
                id: crypto.randomUUID(),
                computerId: crypto.randomUUID(),
                runId: crypto.randomUUID(),
                state: "pending",
                mode: "control",
                consentExpiresAt: new Date(Date.now() + 60_000).toISOString(),
                expiresAt: new Date(Date.now() + 120_000).toISOString(),
            },
            signal
        );
        if (!target) throw new Error("Fixture selection failed.");
        const port = await host.open(target, signal);
        const session = new ComputerWindowSession(port, () =>
            host.assertReady(target, signal)
        );
        try {
            let frame = await session.observe(signal);
            const token = (label: string) => {
                const candidates =
                    frame.elements?.filter((item) => item.label === label) ?? [];
                if (frame.coordinateInput !== false || candidates.length !== 1)
                    throw new Error(
                        "Expected one observed fixture element and no coordinate input."
                    );
                return candidates[0]!.token;
            };
            const firstToken = token("Fixture entry");
            await denied(() =>
                session.act(
                    {
                        action: "click",
                        observationId: frame.observationId,
                        ...state.entry,
                    },
                    signal
                )
            );
            frame = await session.observe(signal);
            await denied(() =>
                session.act(
                    {
                        action: "click_element",
                        observationId: frame.observationId,
                        elementToken: firstToken,
                    },
                    signal
                )
            );
            frame = await session.observe(signal);
            const original = frame.content.find((item) => item.type === "image")!.data;
            await session.act(
                {
                    action: "click_element",
                    observationId: frame.observationId,
                    elementToken: token("Fixture entry"),
                },
                signal
            );
            frame = await session.observe(signal);
            const text = "Mira Windows test 42";
            const input = { action: "type", observationId: frame.observationId, text };
            await session.act(input, signal);
            await eventually((current) => current.text === text);
            await denied(() => session.act(input, signal));
            frame = await session.observe(signal);
            await session.act(
                {
                    action: "click_element",
                    observationId: frame.observationId,
                    elementToken: token("Increment fixture"),
                },
                signal
            );
            await eventually((current) => current.text === text && current.count === 1);
            frame = await session.observe(signal);
            if (frame.content.find((item) => item.type === "image")!.data === original)
                throw new Error(
                    "The captured image did not reflect changed fixture content."
                );
            await session.close();
            await denied(() => session.observe(signal));
            return {
                platform: "windows-x64",
                image: true,
                text: true,
                click: true,
                elementInput: true,
                staleElementDenied: true,
                coordinateInputDenied: true,
                viewOnly: true,
                scopeDenied: true,
                replayDenied: true,
                stopped: true,
            };
        } finally {
            try {
                await session.close();
            } finally {
                await host.close();
            }
        }
    } finally {
        await fixture.close();
    }
}

async function denied(action: () => Promise<unknown>) {
    try {
        await action();
    } catch {
        return;
    }
    throw new Error("A denied Windows operation unexpectedly succeeded.");
}

if (import.meta.main) {
    const [directory, root, ...extra] = process.argv.slice(2);
    if (!directory || !root || extra.length > 0)
        throw new Error("Provide the owned package and fixture directories.");
    process.stdout.write(
        JSON.stringify(await qualifyWindowsInput(directory, root)) + "\n"
    );
}
