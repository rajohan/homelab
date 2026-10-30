import { Effect } from "effect";

import { browserWorkerEnvironment } from "../config/environment";
import { serveBrowserWorker } from "./child";
import { openNativeBrowser } from "./native";
import { browserGrant } from "./policy";
import { prepareSavedBrowserProfile } from "./savedProfile";

if (import.meta.main) {
    await Effect.runPromise(
        Effect.tryPromise({
            try: async () => {
                const saved = browserWorkerEnvironment();
                if (saved) await prepareSavedBrowserProfile();
                return serveBrowserWorker(
                    process.stdin,
                    process.stdout,
                    (input, signal) =>
                        openNativeBrowser(
                            {
                                ...browserGrant(input),
                                ...(saved ? { savedProfile: true } : {}),
                            },
                            signal
                        )
                );
            },
            catch: () => new Error("Browser worker stopped."),
        })
    ).catch(() => {
        process.exitCode = 1;
    });
}
