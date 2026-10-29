import { browserSiteFixture } from "./browserSiteFixture";

/**
 * Serve an offline synthetic site beside the real fixed browser worker.
 * @returns Completion after private stdin closes and the local fixture server stops.
 */
export async function browserWorkerFixture() {
    if (process.platform !== "linux" || !(await Bun.file("/.dockerenv").exists()))
        throw new Error("Use the disposable browser worker image.");
    const server = browserSiteFixture();
    try {
        const worker = Bun.spawn(
            [
                process.execPath,
                "--no-env-file",
                "/source/apps/mira/src/server/browsing/workerCli.ts",
            ],
            { stdin: "inherit", stdout: "inherit", stderr: "inherit" }
        );
        process.exitCode = await worker.exited;
    } finally {
        await server.stop(true);
    }
}

if (import.meta.main) await browserWorkerFixture();
