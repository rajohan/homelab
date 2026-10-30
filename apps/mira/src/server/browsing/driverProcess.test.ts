import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { launchBrowserDriver } from "./driverProcess";

test.skipIf(process.platform !== "linux")(
    "official CLI process layout uses a private socket and reaps its owned daemon",
    async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "mira-driver-process-"));
        const manifest = path.join(directory, "capabilities.json"),
            binary = path.join(directory, "fixture");
        await writeFile(manifest, "{}");
        await writeFile(
            binary,
            `#!${process.execPath}
import { createServer } from "node:net";
import { writeFileSync } from "node:fs";
import assert from "node:assert/strict";
const args=process.argv.slice(2);
if(args[0]==="serve") {
    assert.equal(args[args.indexOf("--permission-mode")+1],"bounded");
    assert(args.includes("--approve-capability-manifest"));
    assert(args.includes("--no-overlay"));
    writeFileSync(args[args.indexOf("--pid-file")+1], String(process.pid));
    createServer().listen(args[args.indexOf("--socket")+1]);
} else {
    assert.equal(args[0],"mcp");
    let buffer="";
    process.stdin.on("data",chunk=>{
        buffer+=chunk;
        for(;;){const end=buffer.indexOf("\\n");if(end<0)break;
            const input=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);
            assert.equal(input.jsonrpc,"2.0");
            if(input.id!==undefined) console.log(JSON.stringify({jsonrpc:"2.0",id:input.id,result:{bounded:true}}));
        }
    });
}
`
        );
        await chmod(binary, 0o700);
        try {
            const host = await launchBrowserDriver(manifest, directory, binary);
            let connection: ReturnType<typeof host.connect> | undefined;
            try {
                await host.ready(new AbortController().signal);
                const pid = Number(
                    await Bun.file(path.join(directory, "driver.pid")).text()
                );
                connection = host.connect();
                expect(await connection.request("initialize", {})).toEqual({
                    bounded: true,
                });
                await connection.close();
                await host.stop();
                await host.stop();
                expect(host.signal.aborted).toBe(true);
                expect(() => process.kill(pid, 0)).toThrow();
                expect(() => host.connect()).toThrow();
                await assert.rejects(host.ready(new AbortController().signal));
            } finally {
                await connection?.close();
                await host.stop();
            }
            await assert.rejects(
                launchBrowserDriver(manifest + ".wrong", directory, binary),
                /private Linux/
            );
            const alias = path.join(directory, "alias");
            await symlink(binary, alias);
            await assert.rejects(
                launchBrowserDriver(manifest, directory, alias),
                /missing/
            );
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }
);

test.skipIf(process.platform !== "linux")(
    "CLI startup cancellation and early process exit leave no live daemon",
    async () => {
        const directory = await mkdtemp(path.join(tmpdir(), "mira-driver-process-"));
        const binary = path.join(directory, "fixture"),
            manifest = path.join(directory, "capabilities.json");
        try {
            await writeFile(binary, `#!${process.execPath}\nprocess.exit(1);\n`);
            await chmod(binary, 0o700);
            const host = await launchBrowserDriver(manifest, directory, binary);
            try {
                await assert.rejects(host.ready(new AbortController().signal));
            } finally {
                await host.stop();
            }
            expect(host.signal.aborted).toBe(true);
            const cancelled = new AbortController();
            cancelled.abort();
            const second = await launchBrowserDriver(manifest, directory, binary);
            try {
                await assert.rejects(second.ready(cancelled.signal));
            } finally {
                await second.stop();
            }
        } finally {
            await rm(directory, { recursive: true, force: true });
        }
    }
);
