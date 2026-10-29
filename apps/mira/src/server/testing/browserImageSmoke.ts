import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { Effect } from "effect";

import { qualifyBrowserWorker } from "./browserWorkerSmoke";

/**
 * Qualify the exact standalone image without adding test files or rebuilding its layers.
 * @param image - Trusted local image tag; external input never reaches a model tool.
 * @returns A receipt after package checks and real protocol/input/cleanup qualification.
 */
export async function qualifyBrowserImage(image: string) {
    const socket = await realpath("/var/run/docker.sock");
    const temporary = await mkdtemp(path.join(os.tmpdir(), "mira-browser-image-test-"));
    const execute = promisify(execFile);
    const docker = async (...args: string[]) => {
        const result = await execute(
            "/usr/bin/docker",
            ["--config", temporary, "--host", `unix://${socket}`, ...args],
            {
                env: { PATH: "/usr/bin:/bin", HOME: temporary },
                timeout: 30_000,
                maxBuffer: 65_536,
            }
        );
        return result.stdout.trim();
    };
    try {
        const [inspection] = JSON.parse(await docker("image", "inspect", image)) as {
            Id: string;
            Architecture: string;
            Os: string;
            Config: {
                User: string;
                Entrypoint: string[];
                ExposedPorts?: unknown;
                Volumes?: unknown;
            };
        }[];
        assert.ok(inspection);
        assert.match(inspection.Id, /^sha256:[a-f0-9]{64}$/);
        assert.equal(inspection.Architecture, "amd64");
        assert.equal(inspection.Os, "linux");
        assert.equal(inspection.Config.User, "bun");
        assert.deepEqual(inspection.Config.Entrypoint, [
            "/usr/bin/timeout",
            "--signal=KILL",
            "305s",
            "/usr/local/bin/mira-browser",
        ]);
        assert.equal(inspection.Config.ExposedPorts, undefined);
        assert.equal(inspection.Config.Volumes, undefined);
        const probe = `import assert from 'node:assert/strict';import {existsSync,readdirSync} from 'node:fs';
            assert.equal(Bun.version,'1.4.4');assert.equal(process.getuid(),1000);
            assert.equal(existsSync('/source'),false);assert.equal(existsSync('/opt/mira-browser/apps'),false);
            const root='/opt/mira-browser/node_modules';const names=readdirSync(root).flatMap(scope=>readdirSync(root+'/'+scope).map(name=>scope+'/'+name)).sort();
            assert.deepEqual(names,['@trycua/cua-driver','@trycua/cua-driver-linux-x64-gnu','@ubjs/core','@ubjs/node','@ubjs/node-linux-x64-gnu']);
            const sdk=await import('@trycua/cua-driver');const driver=sdk.CuaDriver.create();
            try{const m=await driver.metadata();assert.equal(m.driverVersion,'0.37.0');assert.equal(m.embedded,true);}finally{await driver.shutdown();driver.uniffiDestroy();}
            console.log('package-ok');`;
        assert.equal(
            await docker(
                "run",
                "--rm",
                "--network",
                "none",
                "--cap-drop",
                "ALL",
                "--security-opt",
                "no-new-privileges",
                "--read-only",
                "--memory",
                "256m",
                "--cpus",
                "1",
                "--pids-limit",
                "64",
                "--init",
                "--entrypoint",
                "/usr/bin/timeout",
                inspection.Id,
                "--signal=KILL",
                "15s",
                "bun",
                "--no-env-file",
                "-e",
                probe
            ),
            "package-ok"
        );
        const worker = await qualifyBrowserWorker(inspection.Id, true);
        return { runtimePackage: true, unchangedImage: true, ...worker };
    } finally {
        await rm(temporary, { recursive: true, force: true });
    }
}

if (import.meta.main) {
    const [image, ...extra] = process.argv.slice(2);
    if (!image || extra.length > 0) throw new Error("Provide one local browser image.");
    const result = await Effect.runPromise(
        Effect.tryPromise({
            try: () => qualifyBrowserImage(image),
            catch: (cause) => new Error("Browser image qualification failed.", { cause }),
        })
    );
    process.stdout.write(JSON.stringify(result) + "\n");
}
