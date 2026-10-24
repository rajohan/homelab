import assert from "node:assert/strict";

import { BuiltRuntime } from "./testing/builtRuntime";

/** Verify the built Mira package or its release image without provider credentials. */
export async function main(): Promise<void> {
    const runtime = new BuiltRuntime();
    try {
        const child = runtime.spawn("mira", ["--no-env-file", "smoke.js"], {});
        const deadline = setTimeout(() => child.kill("SIGKILL"), 30_000);
        try {
            const [code, output, errors] = await Promise.all([
                child.exited,
                new Response(child.stdout).text(),
                new Response(child.stderr).text(),
            ]);
            assert.equal(code, 0, `Mira artifact smoke failed: ${errors.slice(0, 2000)}`);
            assert.equal(output.trim(), "MIRA_SMOKE_OK");
        } finally {
            clearTimeout(deadline);
        }
    } finally {
        await runtime.close();
    }
}

if (import.meta.main) await main();
