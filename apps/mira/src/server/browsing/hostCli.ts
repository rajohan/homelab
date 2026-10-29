import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { SQL } from "bun";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { Effect } from "effect";
import * as v from "valibot";

import { browserHostEnvironment } from "../config/environment";
import { browserHostConfigurationSchema } from "../data/browserHost";
import { runMiraBrowserHost, type MiraBrowserHealth } from "../data/browserService";

/**
 * Own the private browser host independently of the model runtime and dashboard server.
 * @returns Completion after owned sessions stop; only content-free failures reach stderr.
 */
export async function main(): Promise<void> {
    const { file, databaseUrl, port } = browserHostEnvironment();
    const configuration = v.parse(
        browserHostConfigurationSchema,
        await Bun.file(file).json()
    );
    const client = new SQL(databaseUrl, {
        max: 8,
        connectionTimeout: 5,
        idleTimeout: 20,
    });
    const controller = new AbortController();
    const health: MiraBrowserHealth = {
        ready: false,
        heartbeatAt: 0,
        active: 0,
        unresolved: 0,
    };
    let server: ReturnType<typeof Bun.serve> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
        controller.abort();
        health.ready = false;
        deadline ??= setTimeout(() => {
            throw new Error("Browser host shutdown deadline exceeded.");
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
                    : "../../../../dashboard/migrations",
                import.meta.url
            )
        );
        const expected = readMigrationFiles({ migrationsFolder: folder });
        const applied = await client<
            { name: string; hash: string }[]
        >`SELECT name,hash FROM drizzle.__drizzle_migrations`;
        if (
            expected.length === 0 ||
            expected.length !== applied.length ||
            !expected.every((item) =>
                applied.some((row) => row.name === item.name && row.hash === item.hash)
            )
        )
            throw new Error("Browser host migrations do not match this build.");
        server = Bun.serve({
            hostname: "127.0.0.1",
            port,
            fetch(request) {
                const route = new URL(request.url).pathname;
                const ready =
                    health.ready &&
                    !controller.signal.aborted &&
                    Date.now() - health.heartbeatAt < 15_000;
                if (route === "/health/live") return new Response("ok");
                return new Response(ready ? "ready" : "unavailable", {
                    status: route === "/health/ready" && ready ? 200 : 503,
                });
            },
        });
        await Effect.runPromise(
            Effect.tryPromise({
                try: () =>
                    runMiraBrowserHost({
                        client,
                        configuration,
                        signal: controller.signal,
                        health,
                    }),
                catch: () => new Error("Browser host failed."),
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
        process.stderr.write('{"service":"mira-browser-host","event":"failed"}\n');
        process.exitCode = 1;
    }
}
