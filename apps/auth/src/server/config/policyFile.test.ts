import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadAccessPolicy } from "./policyFile";

test("requires an explicit readable valid bounded policy file", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "homelab-policy-test-"));
    const policyPath = path.join(directory, "policy.yml");
    try {
        await rejectsPolicy(undefined, "required");
        await rejectsPolicy(policyPath, "unavailable");
        await Bun.write(policyPath, "routes: []\n");
        expect(await loadAccessPolicy(policyPath)).toEqual({ routes: [] });
        await Bun.write(policyPath, "routes: [\n");
        await rejectsPolicy(policyPath, "valid YAML");
        await Bun.write(policyPath, " ".repeat(262_145));
        await rejectsPolicy(policyPath, "256 KiB");
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
});

async function rejectsPolicy(
    policyPath: string | undefined,
    message: string
): Promise<void> {
    const error: unknown = await loadAccessPolicy(policyPath).catch(
        (error: unknown) => error
    );
    expect(error).toBeInstanceOf(Error);
    if (!(error instanceof Error)) throw new Error("Expected a failed policy load");
    expect(error.message).toContain(message);
}
