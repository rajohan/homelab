import { test } from "bun:test";
import { rejects } from "node:assert/strict";
import path from "node:path";

import { openWindowsComputerProcess } from "./process";
import { runComputerWorker } from "./workerCli";

test("packaged worker cannot take arbitrary commands or run through an unsupported host", async () => {
    await rejects(runComputerWorker(["--arbitrary-command"]));
    await rejects(runComputerWorker(["--check-runtime", "extra"]));
    await rejects(
        openWindowsComputerProcess(
            {},
            {
                directory: "relative",
                environment: {},
                signal: new AbortController().signal,
            }
        )
    );
    if (process.platform !== "win32")
        await rejects(
            openWindowsComputerProcess(
                {},
                {
                    directory: path.resolve("fixture"),
                    environment: {},
                    signal: new AbortController().signal,
                }
            )
        );
});
