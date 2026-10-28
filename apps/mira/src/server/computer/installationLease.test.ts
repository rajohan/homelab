import { expect, test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { computerEnvironment } from "../config/environment";
import { openComputerInstallationLease } from "./installationLease";

async function fixture(mode = "normal") {
    const directory = await mkdtemp(path.join(tmpdir(), "mira-installation-lease-"));
    const child = path.join(directory, "lease.ts");
    const record = path.join(directory, "record.json");
    await writeFile(
        child,
        `
import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";
const mode = ${JSON.stringify(mode)};
process.stdin.on("end", () => process.exit(0));
createInterface({ input: process.stdin }).on("line", (line) => {
 const request = JSON.parse(line);
 writeFileSync(${JSON.stringify(record)}, JSON.stringify({pid: process.pid, request, unsafe: !!process.env.SYNTHETIC_SECRET}));
 const send = (value) => process.stdout.write(JSON.stringify(value) + String.fromCharCode(10));
 if (mode === "request") send({id: "forbidden", method: "tool", params: {}});
 else if (mode === "notification") send({method: "forbidden", params: {}});
 else send({id: request.id, result: {protocol: mode === "invalid" ? 2 : 1}});
});
`
    );
    return {
        options: {
            command: process.execPath,
            args: ["--no-env-file", child],
            cwd: directory,
            environment: { ...computerEnvironment(), SYNTHETIC_SECRET: "private" },
        },
        record: async () =>
            (await Bun.file(record).json()) as {
                pid: number;
                request: unknown;
                unsafe: boolean;
            },
        remove: () => rm(directory, { recursive: true, force: true }),
    };
}

test("an installation lease remains held until explicit awaited cleanup", async () => {
    const f = await fixture();
    let lease: Awaited<ReturnType<typeof openComputerInstallationLease>> | undefined;
    try {
        lease = await openComputerInstallationLease(f.options);
        const record = await f.record();
        expect(record.request).toEqual({ id: 1, method: "initialize", params: {} });
        expect(record.unsafe).toBe(false);
        expect(lease.signal.aborted).toBe(false);
        expect(() => process.kill(record.pid, 0)).not.toThrow();
        await lease.close();
        expect(lease.signal.aborted).toBe(true);
        expect(() => process.kill(record.pid, 0)).toThrow();
    } finally {
        await lease?.close();
        await f.remove();
    }
});

test.each(["invalid", "request", "notification"])(
    "a %s lease cannot grant a runtime guard",
    async (mode) => {
        const f = await fixture(mode);
        try {
            await rejects(openComputerInstallationLease(f.options));
            const record = await f.record();
            expect(() => process.kill(record.pid, 0)).toThrow();
        } finally {
            await f.remove();
        }
    }
);

test("relative installation helpers are rejected before spawning", async () => {
    const f = await fixture();
    try {
        await rejects(
            openComputerInstallationLease({ ...f.options, command: "relative.exe" }),
            /absolute/
        );
        await rejects(
            openComputerInstallationLease({ ...f.options, cwd: "." }),
            /absolute/
        );
    } finally {
        await f.remove();
    }
});

test("unexpected helper death signals the caller and preserves failed cleanup", async () => {
    const f = await fixture();
    try {
        const lease = await openComputerInstallationLease(f.options);
        const record = await f.record();
        const stopped = new Promise<void>((resolve) =>
            lease.signal.addEventListener("abort", () => resolve(), { once: true })
        );
        process.kill(record.pid, "SIGKILL");
        await stopped;
        await rejects(lease.close(), /cleanup/);
    } finally {
        await f.remove();
    }
});
