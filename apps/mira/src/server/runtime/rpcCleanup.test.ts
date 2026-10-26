import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { computerChildEnvironment } from "../computer/process";
import { RpcProcess, RuntimeCleanupError } from "./rpcProcess";

test("EOF cleanup distinguishes a confirmed supervisor exit from failure and forced termination", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "mira-rpc-cleanup-"));
    const child = path.join(directory, "fixture.ts");
    await Bun.write(
        child,
        `
const mode = process.argv[2];
const alive = setInterval(() => {}, 1000);
process.stdin.on("data", (line) => {
    const input = JSON.parse(line.toString());
    console.log(JSON.stringify({ id: input.id, result: { ready: true } }));
});
process.stdin.on("end", () => {
    if (mode !== "hang") { clearInterval(alive); process.exitCode = mode === "bad" ? 1 : 0; }
});
`
    );
    try {
        for (const mode of ["ok", "bad", "hang"]) {
            const connection = new RpcProcess({
                command: process.execPath,
                args: ["--no-env-file", child, mode],
                cwd: directory,
                env: computerChildEnvironment(process.env),
                stopViaStdin: true,
                requireCleanExit: true,
                onRequest: () => Promise.reject(new Error("Not supported")),
            });
            expect(await connection.request("ready", {})).toEqual({ ready: true });
            if (mode === "ok") {
                await connection.close();
                await connection.close();
            } else {
                await rejects(connection.close(), RuntimeCleanupError);
                await rejects(connection.close(), RuntimeCleanupError);
            }
            expect(connection.signal.aborted).toBe(true);
            await rejects(connection.request("ready", {}));
        }
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
