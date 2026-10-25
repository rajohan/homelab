import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SQL } from "bun";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { Effect } from "effect";

import information from "../../../../package.json";
import { miraServiceConfiguration } from "./config/service";
import { runMiraExecutor, type MiraHealth } from "./executor/runtime";

/**
 * Own Mira's independent server lifecycle, migration check and bounded shutdown.
 * @returns Completion after all active runs settle and owned resources close.
 */
export async function main(): Promise<void> {
    const configuration = await miraServiceConfiguration();
    const client = new SQL(configuration.databaseUrl, {
        max: 6,
        idleTimeout: 20,
        connectionTimeout: 10,
    });
    const controller = new AbortController();
    const health: MiraHealth = {
        ready: false,
        heartbeatAt: 0,
        draining: false,
        active: 0,
    };
    let server: ReturnType<typeof Bun.serve> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
        health.draining = true;
        controller.abort();
        deadline ??= setTimeout(() => {
            throw new Error("Mira shutdown deadline exceeded.");
        }, 30_000);
        deadline.unref();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
        const folder = fileURLToPath(
            new URL(
                existsSync(new URL("migrations", import.meta.url))
                    ? "./migrations"
                    : "../../../dashboard/migrations",
                import.meta.url
            )
        );
        const expected = readMigrationFiles({ migrationsFolder: folder });
        const applied = await client<
            { name: string; hash: string }[]
        >`SELECT name, hash FROM drizzle.__drizzle_migrations`;
        if (
            expected.length === 0 ||
            expected.length !== applied.length ||
            !expected.every((item) =>
                applied.some((row) => row.name === item.name && row.hash === item.hash)
            )
        )
            throw new Error("Mira migrations do not match this build.");
        server = Bun.serve({
            hostname: "127.0.0.1",
            port: configuration.port,
            fetch(request) {
                const path = new URL(request.url).pathname;
                const ready =
                    health.ready &&
                    !health.draining &&
                    Date.now() - health.heartbeatAt < 30_000;
                const status = ready ? "ready" : "unavailable";
                return new Response(path === "/health/live" ? "ok" : status, {
                    status:
                        path === "/health/live" || (path === "/health/ready" && ready)
                            ? 200
                            : 503,
                });
            },
        });
        await Effect.runPromise(
            Effect.tryPromise({
                try: () =>
                    runMiraExecutor({
                        client,
                        config: configuration.config,
                        version: information.version,
                        signal: controller.signal,
                        health,
                        filesDirectory: configuration.filesDirectory,
                        agentMail: configuration.agentMail,
                        moltbook: configuration.moltbook,
                        hereNow: configuration.hereNow,
                        daytona: configuration.daytona,
                        github: configuration.github,
                    }),
                catch: () => new Error("Mira executor failed."),
            })
        );
    } finally {
        stop();
        if (deadline) clearTimeout(deadline);
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
        await server?.stop(true);
        await client.close();
    }
}

if (import.meta.main) {
    try {
        await main();
    } catch {
        process.stderr.write('{"service":"mira","event":"failed"}\n');
        process.exitCode = 1;
    }
}
