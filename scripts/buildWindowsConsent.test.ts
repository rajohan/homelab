import { test } from "bun:test";
import { rejects } from "node:assert/strict";

import { buildWindowsConsent } from "./buildWindowsConsent";
import { testWindowsConsent } from "./testWindowsConsent";

test("Windows builds and native qualification cannot silently succeed on another platform", async () => {
    if (process.platform === "win32") return;
    await rejects(buildWindowsConsent(), /built on Windows/);
    await rejects(testWindowsConsent(), /on Windows/);
});
