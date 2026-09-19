import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";

import { migrate } from "drizzle-orm/bun-sql/migrator";

import { parseAuthConfiguration } from "../apps/auth/src/server/config/configuration";
import { connectAuthDatabase } from "../apps/auth/src/server/database/connection";
import { users, factors } from "../apps/auth/src/server/database/schema";
import { startAuthServer } from "../apps/auth/src/server/index";
import {
    hashPassword,
    randomToken,
    encryptValue,
} from "../apps/auth/src/server/security/crypto";
import {
    developmentTotpSecret,
    developmentTotpCode,
} from "../apps/auth/src/server/testing/developmentTotp";
import { parseDashboardAuthConfiguration } from "../apps/dashboard/src/server/config/auth";
import { parseOperationsConfiguration } from "../apps/dashboard/src/server/config/operations";
import { connectDashboardDatabase } from "../apps/dashboard/src/server/database/connection";
import { migrateDashboard } from "../apps/dashboard/src/server/database/migrations";
import { startDashboardServer } from "../apps/dashboard/src/server/index";
import { publishNotification } from "../apps/dashboard/src/server/notifications/publish";
import { createOperationsRuntime } from "../apps/dashboard/src/server/operations/runtime";
import { createApplicationFixture } from "../apps/dashboard/src/server/testing/applications";
import { runWorker } from "../apps/dashboard/src/worker/runtime";

async function docker(...arguments_: string[]): Promise<string> {
    const child = Bun.spawn(["docker", ...arguments_], {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
    });
    const [output, errors, code] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
    ]);
    if (code !== 0) {
        // Docker errors can repeat environment arguments; never print them.
        void errors;
        throw new Error(
            "Disposable development database operation failed; check Docker availability."
        );
    }
    return output.trim();
}

/**
 * Run an isolated development identity environment with a disposable database.
 * @returns Completion after shutdown and cleanup of this run's owned resources.
 */
export async function main(): Promise<void> {
    // Disposable developer identities only. No production environment is passed to Docker
    // or used as an identity source. Ctrl+C removes this run's exact temporary container.
    const container = `homelab-identity-dev-${crypto.randomUUID()}`;
    const password = randomToken();
    const encryptionKey = crypto.getRandomValues(new Uint8Array(32));
    let created = false;
    let auth: Awaited<ReturnType<typeof startAuthServer>> | undefined;
    let dashboard: ReturnType<typeof startDashboardServer> | undefined;
    let worker: Promise<void> | undefined;
    let operations: ReturnType<typeof createOperationsRuntime> | undefined;
    let applications: ReturnType<typeof createApplicationFixture> | undefined;
    const lifecycle = new AbortController();
    let stopRequested = false;
    let serverShutdownFailed: boolean;
    let requestStop: (() => void) | undefined;
    const stopped = new Promise<void>((resolve) => {
        requestStop = resolve;
    });
    const stop = () => {
        lifecycle.abort();
        stopRequested = true;
        requestStop?.();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);

    async function prepareDatabase(url: string): Promise<void> {
        const connection = connectAuthDatabase(url);
        try {
            let ready = false;
            for (let attempt = 0; attempt < 30 && !stopRequested; attempt += 1) {
                try {
                    await connection.client`select 1`;
                    ready = true;
                    break;
                } catch {
                    await Bun.sleep(300);
                }
            }
            if (!ready) throw new Error("Disposable database did not become ready");
            await migrate(connection.database, {
                migrationsFolder: fileURLToPath(
                    new URL("../apps/auth/migrations", import.meta.url)
                ),
            });
            const userId = crypto.randomUUID();
            await connection.database.insert(users).values({
                id: userId,
                username: "developer",
                email: "developer@example.test",
                emailVerified: false,
                passwordHash: await hashPassword("Development-only-password-123!"),
                groups: ["admins"],
                createdAt: new Date(),
            });
            const factorId = crypto.randomUUID();
            await connection.database.insert(factors).values({
                id: factorId,
                userId,
                kind: "totp",
                label: "Disposable preview authenticator",
                encryptedData: encryptValue(encryptionKey, `factor:${factorId}`, {
                    secret: developmentTotpSecret,
                }),
                createdAt: new Date(),
            });
            await connection.client`CREATE DATABASE homelab_dashboard_dev`;
        } finally {
            await connection.client.close();
        }
    }

    try {
        await docker(
            "run",
            "--detach",
            "--rm",
            "--name",
            container,
            "--label",
            "homelab.purpose=identity-development",
            "--publish",
            "127.0.0.1::5432",
            "--tmpfs",
            "/var/lib/postgresql:rw,size=536870912",
            "--env",
            "POSTGRES_USER=homelab_dev",
            "--env",
            `POSTGRES_PASSWORD=${password}`,
            "--env",
            "POSTGRES_DB=homelab_auth_dev",
            "postgres:18"
        );
        created = true;
        const binding = await docker("port", container, "5432/tcp");
        if (!/^127\.0\.0\.1:\d+$/.test(binding))
            throw new Error("Expected loopback-only database");
        const databaseUrl = `postgres://homelab_dev:${password}@${binding}/homelab_auth_dev`;
        await prepareDatabase(databaseUrl);
        const dashboardUrl = new URL(databaseUrl);
        dashboardUrl.pathname = "/homelab_dashboard_dev";
        applications = createApplicationFixture({
            actionDelayMs: 2000,
            healthDelayMs: 4000,
            includeFailure: true,
        });
        const operationConfiguration = parseOperationsConfiguration({
            NODE_ENV: "development",
            HOMELAB_DASHBOARD_APPLICATION_TARGETS: JSON.stringify([applications.target]),
            HOMELAB_DASHBOARD_LOGS_URL: applications.url,
            HOMELAB_DASHBOARD_DATABASE_URL: dashboardUrl.href,
            // Optional read-only telemetry; identity and operational state remain disposable.
            HOMELAB_DASHBOARD_METRICS_URL: process.env.HOMELAB_PREVIEW_METRICS_URL,
        });
        if (!operationConfiguration)
            throw new Error("Invalid isolated dashboard configuration");
        const dashboardConnection = connectDashboardDatabase(dashboardUrl.href);
        try {
            await migrateDashboard(dashboardConnection);
            await dashboardConnection.client.begin(async (transaction) => {
                for (const [index, severity] of (
                    ["success", "warning", "info", "error"] as const
                ).entries()) {
                    await publishNotification(transaction, "preview", {
                        key: String(index),
                        severity,
                        title:
                            [
                                "Application restart completed",
                                "Application host unavailable",
                                "Scheduled maintenance finished",
                                "Application health check failed",
                            ][index] ?? "Development notification",
                        message:
                            "This is a synthetic preview notification. No production application or alert has changed.",
                        destination: "applications",
                    });
                }
            });
        } finally {
            await dashboardConnection.client.close();
        }
        if (!stopRequested) {
            const clientSecret = randomToken();
            const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 3072 });
            const environment = {
                NODE_ENV: "development",
                HOMELAB_AUTH_DEVELOPMENT: "true",
                HOMELAB_AUTH_ISSUER: "http://localhost:3101",
                HOMELAB_AUTH_DASHBOARD_ORIGIN: "http://localhost:3100",
                HOMELAB_AUTH_RP_ID: "localhost",
                HOMELAB_AUTH_DATABASE_URL: databaseUrl,
                HOMELAB_AUTH_ENCRYPTION_KEY:
                    Buffer.from(encryptionKey).toString("base64"),
                HOMELAB_AUTH_COOKIE_KEY: randomToken(),
                HOMELAB_AUTH_PROXY_KEY: randomToken(),
                HOMELAB_AUTH_JWKS: JSON.stringify({
                    keys: [
                        {
                            ...privateKey.export({ format: "jwk" }),
                            kid: crypto.randomUUID(),
                            alg: "RS256",
                            use: "sig",
                        },
                    ],
                }),
                HOMELAB_AUTH_CLIENTS: JSON.stringify([
                    {
                        client_id: "dashboard",
                        client_secret: clientSecret,
                        client_name: "Development dashboard",
                        redirect_uris: ["http://localhost:3100/auth/callback"],
                        token_endpoint_auth_method: "client_secret_post",
                    },
                ]),
                HOMELAB_AUTH_DASHBOARD_CLIENT_ID: "dashboard",
                HOMELAB_AUTH_EMAIL_FROM: "Development <noreply@example.test>",
                HOMELAB_DASHBOARD_AUTH_DEVELOPMENT: "true",
                HOMELAB_DASHBOARD_AUTH_ISSUER: "http://localhost:3101",
                HOMELAB_DASHBOARD_ORIGIN: "http://localhost:3100",
                HOMELAB_DASHBOARD_OIDC_CLIENT_ID: "dashboard",
                HOMELAB_DASHBOARD_OIDC_CLIENT_SECRET: clientSecret,
                HOMELAB_DASHBOARD_SESSION_KEY: Buffer.from(
                    crypto.getRandomValues(new Uint8Array(32))
                ).toString("base64"),
            };
            const configuration = parseAuthConfiguration(environment);
            const authentication = parseDashboardAuthConfiguration(environment);
            if (!configuration || !authentication)
                throw new Error("Invalid development configuration");
            auth = await startAuthServer({
                hostname: "127.0.0.1",
                port: 3101,
                configuration,
                delivery: (_id, message) => {
                    console.info("DEVELOPMENT MAIL (not sent):", message.text);
                    return Promise.resolve();
                },
            });
            dashboard = startDashboardServer({
                hostname: "127.0.0.1",
                port: 3100,
                authentication,
                development: true,
                operations: operationConfiguration,
            });
            operations = createOperationsRuntime(operationConfiguration);
            worker = runWorker({
                client: operations.client,
                registry: operations.registry,
                concurrency: operationConfiguration.concurrency,
                signal: lifecycle.signal,
                version: "development",
            }).catch(() => {
                stop();
                throw new Error("Development worker failed");
            });
            // Observe failure immediately even while the foreground preview awaits a signal.
            void worker.catch(() => {});
            console.info(
                "Disposable identity and operations preview: http://localhost:3100"
            );
            console.info("Synthetic account: developer / Development-only-password-123!");
            console.info(
                "Preview authenticator code: bun --no-env-file scripts/devIdentity.ts --code"
            );
            console.info(
                "Use synthetic data only. Ctrl+C removes the temporary database and identities."
            );
            await stopped;
        }
    } finally {
        lifecycle.abort();
        const servers = await Promise.allSettled([dashboard?.stop(true), auth?.stop()]);
        serverShutdownFailed = servers.some((result) => result.status === "rejected");
        try {
            await worker;
        } finally {
            try {
                await operations?.client.close();
            } finally {
                try {
                    if (created) await docker("stop", "--time", "5", container);
                } finally {
                    await applications?.close();
                }
            }
        }
    }
    if (serverShutdownFailed)
        throw new Error("Development server shutdown failed after resource cleanup");
}

if (import.meta.main) {
    if (Bun.argv.includes("--code")) console.info(developmentTotpCode());
    else await main();
}
