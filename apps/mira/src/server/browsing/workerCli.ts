import { Effect } from "effect";

import { serveBrowserWorker } from "./child";

if (import.meta.main) {
    await Effect.runPromise(
        Effect.tryPromise({
            try: () => serveBrowserWorker(process.stdin, process.stdout),
            catch: () => new Error("Browser worker stopped."),
        })
    ).catch(() => {
        process.exitCode = 1;
    });
}
