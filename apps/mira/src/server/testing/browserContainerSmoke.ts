import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Effect } from "effect";
import * as v from "valibot";

import { openBrowserConnection } from "../browsing/connection";
import { prepareBrowserContainer } from "../browsing/container";
import { reconcileBrowserContainer } from "../browsing/reconciliation";
import { runtimeContentItems } from "../runtime/toolResult";

const execute = promisify(execFile);
async function fingerprint(pid: string) {
    try {
        return await readFile(`/proc/${pid}/stat`, "utf8");
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT")
            return null;
        throw error;
    }
}
async function eventually(check: () => Promise<boolean>) {
    const deadline = performance.now() + 10_000;
    while (performance.now() < deadline) {
        if (await check()) return;
        await Bun.sleep(50);
    }
    throw new Error("The browser containment fixture did not reach its expected state.");
}

/**
 * Verify real container-owned Chromium termination even when its driver is stopped by SIGSTOP.
 * @returns A receipt after explicit close and owner cancellation remove every observed process.
 */
export async function qualifyBrowserContainer() {
    if (process.platform !== "linux")
        throw new Error("Use the isolated Linux browser qualification host.");
    const socket = await realpath("/var/run/docker.sock");
    const temporary = await mkdtemp(path.join(os.tmpdir(), "mira-browser-host-test-"));
    const docker = async (...args: string[]) => {
        const result = await execute(
            "/usr/bin/docker",
            ["--config", temporary, "--host", `unix://${socket}`, ...args],
            {
                env: { PATH: "/usr/bin:/bin", HOME: temporary },
                timeout: 10_000,
                maxBuffer: 64 * 1024,
            }
        );
        return result.stdout.trim();
    };
    try {
        const image = await docker(
            "image",
            "inspect",
            "homelab-browser-test:local",
            "--format",
            "{{.Id}}"
        );
        for (const cancel of [false, true]) {
            const owner = new AbortController();
            const lease = await prepareBrowserContainer(
                { socketPath: socket, imageId: image },
                owner.signal
            );
            try {
                await lease.start();
                let pid = 0;
                await eventually(async () => {
                    let text: string;
                    try {
                        text = await docker(
                            "exec",
                            lease.id,
                            "cat",
                            "/tmp/mira-browser-container-ready.json"
                        );
                    } catch {
                        return false;
                    }
                    const ready = v.parse(
                        v.strictObject({
                            pid: v.pipe(v.number(), v.integer(), v.minValue(1)),
                            image: v.literal(true),
                        }),
                        JSON.parse(text)
                    );
                    pid = ready.pid;
                    return true;
                });
                const listing = await docker("top", lease.id, "-eo", "pid,comm");
                const processes = listing
                    .split("\n")
                    .slice(1)
                    .map((line) => line.trim().split(/\s+/, 2));
                assert.ok(processes.some((row) => row[1]?.includes("chromium")));
                const fingerprints = new Map<string, string>();
                for (const row of processes) {
                    assert.match(row[0]!, /^[0-9]+$/);
                    const stamp = await fingerprint(row[0]!);
                    assert.ok(stamp);
                    fingerprints.set(row[0]!, stamp);
                }
                // Freeze only the PID reported by our synthetic fixture inside this container.
                // Native shutdown cannot help; container teardown must kill all descendants.
                await docker(
                    "exec",
                    lease.id,
                    "bun",
                    "-e",
                    'process.kill(Number(process.argv[1]), "SIGSTOP")',
                    String(pid)
                );
                if (cancel) owner.abort();
                else {
                    // A restarted host has the durable owner/name even if the
                    // original create response never reached its database.
                    const proof = await reconcileBrowserContainer(
                        { socketPath: socket, imageId: image },
                        {
                            id: lease.name.slice("mira-browser-".length),
                            phase: "creating",
                            containerId: null,
                        },
                        () => Promise.resolve()
                    );
                    assert.deepEqual(proof, { kind: "removed", containerId: lease.id });
                }
                await lease.close();
                assert.deepEqual(
                    await reconcileBrowserContainer(
                        { socketPath: socket, imageId: image },
                        {
                            id: lease.name.slice("mira-browser-".length),
                            phase: "created",
                            containerId: lease.id,
                        },
                        () => Promise.resolve()
                    ),
                    { kind: "absent", containerId: lease.id }
                );
                await eventually(async () => {
                    for (const [hostPid, before] of fingerprints) {
                        const after = await fingerprint(hostPid);
                        // /proc start time survives ordinary state/counter changes.
                        if (
                            after &&
                            after.slice(after.lastIndexOf(")") + 2).split(" ")[19] ===
                                before.slice(before.lastIndexOf(")") + 2).split(" ")[19]
                        )
                            return false;
                    }
                    return true;
                });
                await assert.rejects(docker("inspect", lease.id));
                assert.equal(lease.signal.aborted, true);
                await assert.rejects(lease.start());
            } finally {
                await lease.close();
            }
        }
        for (const cancel of [false, true]) {
            const owner = new AbortController();
            let selected = "";
            const connection = await openBrowserConnection(
                { socketPath: socket, imageId: image },
                owner.signal,
                {
                    prepare: async (config, signal) => {
                        const lease = await prepareBrowserContainer(config, signal);
                        selected = lease.id;
                        return lease;
                    },
                }
            );
            try {
                for (let index = 0; index < 2; index++) {
                    const frame = v.parse(
                        v.object({
                            title: v.literal("Containment fixture"),
                            width: v.pipe(v.number(), v.minValue(1)),
                            content: v.unknown(),
                        }),
                        await connection.request({ operation: "observe" }, owner.signal)
                    );
                    const items = runtimeContentItems(frame.content);
                    assert.equal(items.length, 1);
                    assert.equal(items[0]!.type, "inputImage");
                }
                if (cancel) {
                    const operation = new AbortController();
                    const pending = assert.rejects(
                        connection.request({ operation: "hang" }, operation.signal),
                        /Do not replay/
                    );
                    await eventually(async () => {
                        try {
                            const text = await docker(
                                "exec",
                                selected,
                                "cat",
                                "/tmp/mira-browser-transport-hang.json"
                            );
                            return (
                                v.parse(
                                    v.strictObject({ id: v.literal(3) }),
                                    JSON.parse(text)
                                ).id === 3
                            );
                        } catch {
                            return false;
                        }
                    });
                    operation.abort();
                    await pending;
                }
            } finally {
                await connection.close();
            }
            await assert.rejects(docker("inspect", selected));
            await assert.rejects(
                connection.request({ operation: "observe" }, owner.signal)
            );
        }
        return {
            durableRecovery: true,
            unknownCreateRemoved: true,
            knownAbsence: true,
            privateStdio: true,
            tabFrames: true,
            cancelledRequestRemoved: true,
            noReplay: true,
            platform: "linux-docker",
            realChromium: true,
            driverFrozen: true,
            explicitStop: true,
            ownerCancellation: true,
            descendantsGone: true,
            noRestart: true,
        };
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
}

if (import.meta.main) {
    const receipt = await Effect.runPromise(
        Effect.tryPromise({
            try: qualifyBrowserContainer,
            catch: (cause) =>
                new Error("Browser container qualification failed.", { cause }),
        })
    );
    process.stdout.write(JSON.stringify(receipt) + "\n");
}
