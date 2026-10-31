import { expect, spyOn, test } from "bun:test";

import {
    parseReleaseDeploymentTargets,
    releaseDeploymentRevision,
} from "./deploymentConfiguration";
import {
    deploymentTestConnections as connections,
    deploymentTestTarget as target,
} from "./deploymentFixtures";
import { deploymentDigest, deploymentHost } from "./deploymentProtocol";

test("deployment recipes require explicit compatible services, authority and private state", () => {
    expect(parseReleaseDeploymentTargets(undefined, connections)).toEqual([]);
    expect(parseReleaseDeploymentTargets(JSON.stringify([target]), connections)).toEqual([
        target,
    ]);
    for (const change of [
        { connection: "missing" },
        { composeFile: "/elsewhere/compose.yaml" },
        { stateDirectory: "/srv/homelab" },
        { services: [{ name: "mira", app: "mira" }] },
        { services: [{ name: "dashboard", app: "dashboard" }] },
        { units: ["bad;reboot.service"] },
        { composeCommand: ["docker", "compose"] },
        { directory: "/srv/../etc" },
        { browserConfigFile: "/srv/browser.json" },
        { browserProxyUnits: ["homelab.service"] },
        { migrateCommand: ["/bin/sh", "bad\ncommand"] },
    ])
        expect(() =>
            parseReleaseDeploymentTargets(
                JSON.stringify([{ ...target, ...change }]),
                connections
            )
        ).toThrow();
    expect(() =>
        parseReleaseDeploymentTargets(JSON.stringify([target, target]), connections)
    ).toThrow();
    expect(releaseDeploymentRevision(target, connections)).not.toBe(
        releaseDeploymentRevision(
            { ...target, backupCommand: ["/usr/bin/false"] },
            connections
        )
    );
});

test("browser proxy startup units must be a distinct subset of the complete deployment", () => {
    const browser = {
        ...target,
        browserConfigFile: "/srv/browser.json",
        browserProxyUnits: ["proxy.service"],
        units: ["homelab.service", "proxy.service"],
        services: [
            ...target.services,
            { name: "proxy", app: "mira-browser-proxy" as const },
        ],
    };
    expect(parseReleaseDeploymentTargets(JSON.stringify([browser]), connections)).toEqual(
        [browser]
    );
    for (const units of [
        [],
        ["missing.service"],
        ["proxy.service", "proxy.service"],
        browser.units,
    ])
        expect(() =>
            parseReleaseDeploymentTargets(
                JSON.stringify([{ ...browser, browserProxyUnits: units }]),
                connections
            )
        ).toThrow();
    expect(releaseDeploymentRevision(target, connections)).not.toBe(
        releaseDeploymentRevision(
            parseReleaseDeploymentTargets(JSON.stringify([browser]), connections)[0]!,
            connections
        )
    );
});

test("journal digests use deterministic recursive JSON with UTF-8 labels", async () => {
    const value = { z: [1, { b: true, a: null }], a: "Vert – æøå" };
    expect(deploymentDigest(value)).toBe(
        deploymentDigest({ a: value.a, z: [1, { a: null, b: true }] })
    );
    const child = Bun.spawn(
        [
            "python3",
            "-I",
            "-B",
            "-c",
            "import json,hashlib,sys;print(hashlib.sha256(json.dumps(json.load(sys.stdin),sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()).hexdigest())",
        ],
        {
            stdin: new TextEncoder().encode(JSON.stringify(value)),
            stdout: "pipe",
            stderr: "pipe",
        }
    );
    const result = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(result.trim()).toBe(deploymentDigest(value));
});

test("host journal refuses replay and distinguishes recoverable failures from database migration", async () => {
    const child = Bun.spawn(
        [
            "python3",
            "-I",
            "-B",
            new URL("deploymentHostTests.py", import.meta.url).pathname,
        ],
        { stdout: "pipe", stderr: "pipe" }
    );
    const [stdout, stderr] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
    ]);
    expect(await child.exited).toBe(0);
    expect(stdout + stderr).toContain("OK");
});

test.each(["valid", "oversized", "invalid", "failure"])(
    "SSH receipt transport validates %s output and reaps its child",
    async (kind) => {
        const id = crypto.randomUUID();
        const value = { state: "absent", id };
        const output =
            kind === "valid"
                ? JSON.stringify({ ok: true, result: value })
                : "x".repeat(kind === "oversized" ? 70_000 : 3);
        const child = Bun.spawn(
            [
                process.execPath,
                "-e",
                `process.stdout.write(${JSON.stringify(output)});${kind === "oversized" ? "setInterval(() => {}, 1000);" : `process.exitCode=${kind === "failure" ? 1 : 0};`}`,
            ],
            { stdin: "pipe", stdout: "pipe", stderr: "pipe" }
        );
        const spawn = spyOn(Bun, "spawn").mockReturnValueOnce(child);
        try {
            const operation = deploymentHost(
                connections[0]!,
                { mode: "status", target, id },
                AbortSignal.timeout(3000)
            );
            if (kind === "valid") expect(await operation).toEqual(value);
            else {
                const failure: unknown = await operation.then(
                    () => null,
                    (error: unknown) => error
                );
                expect(failure).toBeInstanceOf(Error);
            }
            expect(spawn).toHaveBeenCalledTimes(1);
            expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
        } finally {
            spawn.mockRestore();
            if (child.exitCode === null && child.signalCode === null) child.kill();
            await child.exited;
        }
    }
);
