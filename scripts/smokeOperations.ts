import assert from "node:assert/strict";

import { SQL } from "bun";

import { createTestDatabase } from "../tests/database";
import { BuiltRuntime } from "./testing/builtRuntime";

/**
 * Exercise the independently built migration and worker artifacts against disposable data.
 * @returns Completion after a scheduled job succeeds and every owned process is stopped.
 */
export async function main(): Promise<void> {
    const allocation = await createTestDatabase();
    const client = new SQL(allocation.url, { max: 1, connectionTimeout: 5 });
    const runtime = new BuiltRuntime();
    const reservation = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response(null),
    });
    const port = reservation.port;
    await reservation.stop(true);
    const environment = {
        NODE_ENV: "production",
        HOMELAB_DASHBOARD_DATABASE_URL: allocation.url,
        HOMELAB_DASHBOARD_WORKER_PORT: String(port),
    };
    try {
        const migration = runtime.spawn(
            "dashboard",
            ["--no-env-file", "migrate.js", "--apply"],
            environment
        );
        const deadline = setTimeout(() => migration.kill("SIGKILL"), 15_000);
        try {
            assert.equal(
                await migration.exited,
                0,
                "Built dashboard migration must succeed"
            );
        } finally {
            clearTimeout(deadline);
        }
        const worker = runtime.spawn(
            "dashboard",
            ["--no-env-file", "worker.js"],
            environment
        );
        let completed = false;
        for (let attempt = 0; attempt < 100; attempt += 1) {
            const [run] = await client<
                { state: string }[]
            >`SELECT state FROM job_runs WHERE action = 'system.retention' ORDER BY id DESC LIMIT 1`;
            if (run?.state === "succeeded") {
                completed = true;
                break;
            }
            if (worker.exitCode !== null) break;
            await Bun.sleep(50);
        }
        assert.ok(
            completed,
            "The built worker must execute its registered scheduled job"
        );
        const response = await fetch(`http://127.0.0.1:${port}/health/ready`, {
            signal: AbortSignal.timeout(1000),
        });
        assert.equal(response.status, 200);
        console.info(
            "PASS: built dashboard migration, separate Bun worker, scheduled job and private readiness."
        );
    } finally {
        try {
            await runtime.close();
        } finally {
            try {
                await client.close();
            } finally {
                await allocation.close();
            }
        }
    }
}

if (import.meta.main) await main();
