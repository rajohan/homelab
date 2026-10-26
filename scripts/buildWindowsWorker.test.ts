import { test } from "bun:test";
import { rejects } from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { buildWindowsWorker } from "./buildWindowsWorker";
import { buildWindowsWorkerHost } from "./buildWindowsWorkerHost";
import { testWindowsWorker } from "./testWindowsWorker";

test("Windows worker entrypoints refuse unsupported commands, platforms and relative output", async () => {
    await rejects(buildWindowsWorker("relative"));
    await rejects(buildWindowsWorkerHost("relative"));
    if (process.platform === "win32") return;
    const root = await mkdtemp(path.join(tmpdir(), "mira-worker-build-test-"));
    try {
        await rejects(buildWindowsWorker(root));
        await rejects(buildWindowsWorkerHost(root));
        await rejects(testWindowsWorker());
    } finally {
        await rm(root, { recursive: true, force: true });
    }
});
