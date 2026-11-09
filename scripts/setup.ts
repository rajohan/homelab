import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { verifyBun } from "./verifyBun";

/**
 * Verify the pinned Bun runtime and install repository development hooks.
 * @returns Completion after local repository setup is ready.
 */
export async function main(): Promise<void> {
    const repositoryRoot = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
    await verifyBun();

    const git = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
        stdout: "pipe",
        stderr: "ignore",
    });

    if (
        git.exitCode === 0 &&
        realpathSync(new TextDecoder().decode(git.stdout).trim()) === repositoryRoot
    ) {
        const hooks = Bun.spawn(
            [process.execPath, "node_modules/lefthook/bin/index.js", "install"],
            {
                stdin: "inherit",
                stdout: "inherit",
                stderr: "inherit",
            }
        );
        if ((await hooks.exited) !== 0) {
            throw new Error("Could not install repository Git hooks.");
        }
    } else {
        console.info(
            "This folder is not its own Git checkout; Git hooks were not installed."
        );
    }

    console.info(
        "Foundation ready. Run bun run dev to start the loopback-only applications."
    );
    console.info(
        "No production credentials, databases, services or configuration were changed."
    );
}

if (import.meta.main) await main();
