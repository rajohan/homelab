import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { CuaDriver, SessionPermissionMode } from "@trycua/cua-driver";
import { Effect } from "effect";
import * as v from "valibot";

import { openNativeComputerWindow } from "../computer/native";
import { computerWindowManifest } from "../computer/policy";
import { openComputerProcess } from "../computer/process";
import { ComputerWindowSession } from "../computer/session";
import { computerEnvironment } from "../config/environment";

const point = v.object({ x: v.number(), y: v.number() });
const stateSchema = v.object({
    pid: v.number(),
    executable: v.string(),
    text: v.string(),
    count: v.number(),
    entry: point,
    button: point,
});
async function readState() {
    return v.parse(
        stateSchema,
        await Bun.file("/tmp/mira-computer-fixture/state.json").json()
    );
}
async function assertEventually(
    check: (state: v.InferOutput<typeof stateSchema>) => boolean
) {
    const deadline = performance.now() + 3000;
    while (performance.now() < deadline) {
        if (check(await readState())) return;
        await Bun.sleep(25);
    }
    throw new Error("Computer input was not confirmed by the independent fixture state.");
}

/**
 * Verify the real native adapter exclusively inside the repository's disposable X11 fixture.
 * @returns A content-free qualification receipt after image, input, denial and stop checks.
 */
export async function qualifyComputerFixture() {
    if (process.platform !== "linux" || !(await Bun.file("/.dockerenv").exists()))
        throw new Error("Use the isolated computer-test image for this qualification.");
    const fixture = await readState();
    const temporary = await mkdtemp("/tmp/mira-computer-discovery-");
    const manifestPath = path.join(temporary, "manifest.json");
    // Discovery belongs to the qualification host, scoped to the known fixture PID/app.
    // Product/model ports never receive this discovery driver or its extra tool.
    const ceiling = computerWindowManifest({
        executable: fixture.executable,
        pid: fixture.pid,
        windowId: "1",
        delivery: "foreground",
    });
    ceiling.allow.tools.push("list_windows");
    await writeFile(manifestPath, JSON.stringify(ceiling), { mode: 0o600 });
    const discovery = CuaDriver.createConfigured({
        claudeCodeCompatibility: false,
        authorization: {
            allowedModes: [SessionPermissionMode.Bounded],
            compatibilityMode: SessionPermissionMode.Bounded,
            compatibilityCapabilityManifestPath: manifestPath,
            unrestrictedAcknowledged: false,
            maxSessionTtlSeconds: 300n,
            maxIdleTtlSeconds: 60n,
        },
    });
    let windowId: string;
    try {
        let selected: string | undefined;
        for (let attempt = 0; attempt < 50; attempt++) {
            const windows = await discovery.listWindows({ pid: fixture.pid });
            const window = windows.windows[0];
            if (
                windows.windows.length === 1 &&
                window?.pid === fixture.pid &&
                window.title === "Mira isolated input fixture"
            ) {
                selected = window.windowId.toString();
                break;
            }
            // EWMH may expose the window before publishing its title and owning PID.
            await Bun.sleep(100);
        }
        if (!selected)
            throw new Error("The fixture did not expose one exact native window.");
        windowId = selected;
        let denied = false;
        try {
            await discovery.listWindows({});
        } catch {
            denied = true;
        }
        if (!denied)
            throw new Error("The fixture policy unexpectedly allowed desktop discovery.");
    } finally {
        await discovery.shutdown();
        if (CuaDriver.instanceOf(discovery)) discovery.uniffiDestroy();
        await rm(temporary, { recursive: true, force: true });
    }
    const grant = {
        executable: fixture.executable,
        pid: fixture.pid,
        windowId,
        delivery: "foreground",
    };
    const wrong = await openNativeComputerWindow({
        ...grant,
        executable: await realpath(process.execPath),
    });
    try {
        let denied = false;
        try {
            await wrong.observe(AbortSignal.timeout(3000));
        } catch {
            denied = true;
        }
        if (!denied)
            throw new Error("The driver observed an executable outside its manifest.");
    } finally {
        await wrong.close();
    }
    const port = await openComputerProcess(grant, {
        entrypoint: fileURLToPath(new URL("../computer/child.ts", import.meta.url)),
        cwd: process.cwd(),
        environment: computerEnvironment(),
        signal: AbortSignal.timeout(30_000),
    });
    const session = new ComputerWindowSession(port, () => Promise.resolve());
    const signal = AbortSignal.timeout(30_000);
    try {
        let frame = await session.observe(signal);
        await session.act(
            { action: "click", observationId: frame.observationId, ...fixture.entry },
            signal
        );
        frame = await session.observe(signal);
        const literal = "Mira test 42";
        const type = {
            action: "type",
            observationId: frame.observationId,
            text: literal,
        };
        await session.act(type, signal);
        await assertEventually((state) => state.text === literal);
        let replayDenied = false;
        try {
            await session.act(type, signal);
        } catch {
            replayDenied = true;
        }
        if (!replayDenied) throw new Error("An input observation was reused.");
        frame = await session.observe(signal);
        await session.act(
            { action: "click", observationId: frame.observationId, ...fixture.button },
            signal
        );
        await assertEventually((state) => state.count === 1 && state.text === literal);
        await session.close();
        let stopped = false;
        try {
            await session.observe(signal);
        } catch {
            stopped = true;
        }
        if (!stopped) throw new Error("The closed session retained computer authority.");
        return {
            driver: "0.37.0",
            platform: "linux-x11",
            image: true,
            text: true,
            click: true,
            deniedScope: true,
            replayDenied: true,
            stopped: true,
            supervised: true,
        };
    } finally {
        await session.close();
    }
}

if (import.meta.main) {
    const result = await Effect.runPromise(
        Effect.tryPromise({
            try: qualifyComputerFixture,
            catch: (cause) =>
                new Error("Isolated computer qualification failed.", { cause }),
        })
    );
    process.stdout.write(JSON.stringify(result) + "\n");
}
