import { generateKeyPairSync } from "node:crypto";

import { migrate } from "drizzle-orm/bun-sql/migrator";

import { parseAuthConfiguration } from "../apps/auth/src/configuration";
import { connectAuthDatabase } from "../apps/auth/src/database/connection";
import { users } from "../apps/auth/src/database/schema";
import { hashPassword, randomToken } from "../apps/auth/src/security/crypto";
import { startAuthServer } from "../apps/auth/src/server";
import { parseDashboardAuthConfiguration } from "../apps/dashboard/src/authConfiguration";
import { startDashboardServer } from "../apps/dashboard/src/server";

// Disposable developer identities only. No production environment is passed to Docker
// or used as an identity source. Ctrl+C removes this run's exact temporary container.
const container = `homelab-identity-dev-${crypto.randomUUID()}`;
const password = randomToken();
let created = false;
let auth: Awaited<ReturnType<typeof startAuthServer>> | undefined;
let dashboard: ReturnType<typeof startDashboardServer> | undefined;
let stopRequested = false;
let requestStop: (() => void) | undefined;
const stopped = new Promise<void>((resolve) => {
    requestStop = resolve;
});
const stop = () => {
    stopRequested = true;
    requestStop?.();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

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
            migrationsFolder: new URL("../apps/auth/migrations", import.meta.url)
                .pathname,
        });
        await connection.database.insert(users).values({
            id: crypto.randomUUID(),
            username: "developer",
            email: "developer@example.test",
            emailVerified: false,
            passwordHash: await hashPassword("Development-only-password-123!"),
            groups: ["admins"],
            createdAt: new Date(),
        });
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
            HOMELAB_AUTH_ENCRYPTION_KEY: Buffer.from(
                crypto.getRandomValues(new Uint8Array(32))
            ).toString("base64"),
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
        });
        console.info("Disposable identity preview: http://localhost:3100");
        console.info("Synthetic account: developer / Development-only-password-123!");
        console.info(
            "Use synthetic data only. Ctrl+C removes the temporary database and identities."
        );
        await stopped;
    }
} finally {
    await dashboard?.stop(true);
    await auth?.stop();
    if (created) await docker("stop", "--time", "5", container);
}
