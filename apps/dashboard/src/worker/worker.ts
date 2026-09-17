import { Effect } from "effect";

import information from "../../../../package.json";
import {
    dashboardOperationsConfiguration,
    workerHealthBinding,
} from "../server/config/environment";
import { assertDashboardSchema } from "../server/database/migrations";
import { createOperationsRuntime } from "../server/operations/runtime";
import { createWorkerState, startWorkerHealth } from "./health";
import { runWorker } from "./runtime";

/**
 * Own the worker process lifecycle, schema check, safe diagnostics and shutdown budget.
 * @returns Completion after a signal-driven shutdown or a fatal startup/runtime error.
 */
export async function main(): Promise<void> {
    const configuration = dashboardOperationsConfiguration();
    if (!configuration) throw new Error("Dashboard database configuration is required");
    const runtime = createOperationsRuntime(configuration);
    const controller = new AbortController();
    const state = createWorkerState();
    let health: ReturnType<typeof startWorkerHealth> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
        state.draining = true;
        controller.abort();
        deadline ??= setTimeout(() => {
            throw new Error("Worker shutdown deadline exceeded");
        }, 30_000);
        deadline.unref();
    };
    process.on("SIGTERM", stop);
    process.on("SIGINT", stop);
    try {
        await assertDashboardSchema(runtime);
        health = startWorkerHealth(state, workerHealthBinding());
        await Effect.runPromise(
            Effect.tryPromise({
                try: () =>
                    runWorker({
                        client: runtime.client,
                        registry: runtime.registry,
                        concurrency: configuration.concurrency,
                        signal: controller.signal,
                        version: information.version,
                        state,
                    }),
                catch: () => new Error("Dashboard worker stopped unexpectedly"),
            })
        );
    } finally {
        if (deadline) clearTimeout(deadline);
        process.off("SIGTERM", stop);
        process.off("SIGINT", stop);
        await health?.stop(true);
        await runtime.client.close();
    }
}
if (import.meta.main) {
    try {
        await main();
    } catch {
        process.stderr.write('{"service":"dashboard-worker","event":"failed"}\n');
        process.exitCode = 1;
    }
}
