import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { miraHostCommandSchema } from "@homelab/contracts/miraOperations";
import * as v from "valibot";

import { miraOperationsBinding, readMiraOperations } from "./configuration";
import { miraOperationsSshArguments } from "./ssh";

const target = {
    id: "main",
    label: "Main",
    host: "10.77.20.2",
    user: "fixture",
    port: 22,
    identityFile: "/private/main",
    knownHostsFile: "/private/known_hosts",
};

test("host authority is explicit, validates destinations and pins every connection field", async () => {
    expect(await readMiraOperations()).toBeUndefined();
    const directory = await mkdtemp(path.join(tmpdir(), "mira-operations-"));
    const file = path.join(directory, "configuration.json");
    const owner = crypto.randomUUID();
    try {
        await writeFile(file, JSON.stringify({ owner, targets: [target] }));
        // Native production uses Linux absolute paths; synthetic file paths follow the test OS.
        if (process.platform !== "win32")
            expect(await readMiraOperations(file)).toEqual({ owner, targets: [target] });
        for (const replacement of [
            { ...target, host: "-oProxyCommand=bad" },
            { ...target, user: "root; bad" },
            { ...target, identityFile: "relative/key" },
        ]) {
            await writeFile(file, JSON.stringify({ owner, targets: [replacement] }));
            await expect(readMiraOperations(file)).rejects.toThrow();
        }
        expect(miraOperationsBinding(owner, target)).not.toBe(
            miraOperationsBinding(owner, { ...target, user: "another" })
        );
        const argv = miraOperationsSshArguments(target);
        expect(argv).toContain("StrictHostKeyChecking=yes");
        expect(argv).toContain("IdentityAgent=none");
        expect(argv.slice(-3)).toEqual(["--", "10.77.20.2", "sh -s"]);
        expect(
            v.safeParse(miraHostCommandSchema, {
                target: "main",
                command: "printf ok\0bad",
                reason: "test",
            }).success
        ).toBe(false);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});
