import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { fileURLToPath } from "node:url";

import { createTestDatabase } from "../tests/database";

async function port(): Promise<number> {
    const listener = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response(null),
    });
    const number = listener.port;
    await listener.stop(true);
    if (!number) throw new Error("No test port");
    return number;
}

function redirect(value: unknown): string {
    assert.ok(
        typeof value === "object" &&
            value !== null &&
            "redirect" in value &&
            typeof value.redirect === "string"
    );
    return value.redirect;
}

const random = () =>
    Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url");

const cwd = (app: string) =>
    fileURLToPath(new URL(`../apps/${app}/dist/`, import.meta.url));

/**
 * Verify the built auth and dashboard identity flow against the isolated test database.
 * @returns Completion after migration, login and logout checks, process cleanup and database removal.
 */
export async function main(): Promise<void> {
    const database = await createTestDatabase();
    try {
        await verifyBuiltIdentity(database.url);
    } finally {
        await database.close();
    }
}

async function verifyBuiltIdentity(databaseUrl: string): Promise<void> {
    const children: Array<ReturnType<typeof Bun.spawn>> = [];
    const jar = new Map<string, string>();
    const password = "Built-smoke-password-not-production";
    const username = `built-${crypto.randomUUID()}`;

    const [authPort, dashboardPort] = await Promise.all([port(), port()]);
    const issuer = `http://localhost:${authPort}`,
        origin = `http://localhost:${dashboardPort}`;

    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const clientSecret = random();
    const authEnvironment = {
        NODE_ENV: "development",
        HOMELAB_AUTH_POLICY_FILE: new URL("../tests/access-policy.yml", import.meta.url)
            .pathname,
        HOMELAB_AUTH_DEVELOPMENT: "true",
        HOMELAB_AUTH_HOST: "127.0.0.1",
        HOMELAB_AUTH_PORT: String(authPort),
        HOMELAB_AUTH_ISSUER: issuer,
        HOMELAB_AUTH_DASHBOARD_ORIGIN: origin,
        HOMELAB_AUTH_RP_ID: "localhost",
        HOMELAB_AUTH_DATABASE_URL: databaseUrl,
        HOMELAB_AUTH_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString("base64"),
        HOMELAB_AUTH_COOKIE_KEY: random(),
        HOMELAB_AUTH_PROXY_KEY: random(),
        HOMELAB_AUTH_JWKS: JSON.stringify({
            keys: [
                {
                    ...privateKey.export({ format: "jwk" }),
                    kid: "built-smoke",
                    alg: "RS256",
                    use: "sig",
                },
            ],
        }),
        HOMELAB_AUTH_CLIENTS: JSON.stringify([
            {
                client_id: "dashboard",
                client_secret: clientSecret,
                client_name: "Built smoke",
                redirect_uris: [origin + "/auth/callback"],
                token_endpoint_auth_method: "client_secret_post",
            },
        ]),
        HOMELAB_AUTH_DASHBOARD_CLIENT_ID: "dashboard",
        HOMELAB_AUTH_EMAIL_FROM: "Smoke <noreply@example.test>",
    };
    const dashboardEnvironment = {
        NODE_ENV: "development",
        HOMELAB_DASHBOARD_AUTH_DEVELOPMENT: "true",
        HOMELAB_DASHBOARD_HOST: "127.0.0.1",
        HOMELAB_DASHBOARD_PORT: String(dashboardPort),
        HOMELAB_DASHBOARD_AUTH_ISSUER: issuer,
        HOMELAB_DASHBOARD_ORIGIN: origin,
        HOMELAB_DASHBOARD_OIDC_CLIENT_ID: "dashboard",
        HOMELAB_DASHBOARD_OIDC_CLIENT_SECRET: clientSecret,
        HOMELAB_DASHBOARD_SESSION_KEY: Buffer.alloc(32, 19).toString("base64"),
    };

    async function admin(action: string, input?: unknown) {
        const child = Bun.spawn([process.execPath, "--no-env-file", "admin.js", action], {
            cwd: cwd("auth"),
            env: authEnvironment,
            stdin: input === undefined ? "ignore" : new Blob([JSON.stringify(input)]),
            stdout: "pipe",
            stderr: "pipe",
        });
        const [code] = await Promise.all([
            child.exited,
            new Response(child.stdout).text(),
            new Response(child.stderr).text(),
        ]);
        assert.equal(
            code,
            0,
            "Built administrative command failed; no private input was logged."
        );
    }
    function start(app: string, environment: Record<string, string>) {
        const child = Bun.spawn([process.execPath, "--no-env-file", "index.js"], {
            cwd: cwd(app),
            env: environment,
            stdin: "ignore",
            stdout: "ignore",
            stderr: "inherit",
        });
        children.push(child);
    }
    async function ready(url: string) {
        for (let attempt = 0; attempt < 50; attempt += 1) {
            try {
                const response = await fetch(url + "/health/ready", {
                    signal: AbortSignal.timeout(500),
                });
                if (response.ok) return;
            } catch {
                /* The process may not have bound its listener yet. */
            }
            if (children.some((child) => child.exitCode !== null))
                throw new Error("Built process exited before readiness");
            await Bun.sleep(100);
        }
        throw new Error("Built process was not ready");
    }
    async function request(value: string, input?: unknown): Promise<Response> {
        const url = new URL(value);
        assert.ok(
            url.origin === issuer || url.origin === origin,
            "Smoke must not contact an external service"
        );
        const response = await fetch(url, {
            redirect: "manual",
            signal: AbortSignal.timeout(5000),
            method: input === undefined ? "GET" : "POST",
            headers: {
                cookie: [...jar].map(([key, val]) => key + "=" + val).join("; "),
                ...(input === undefined
                    ? {}
                    : { origin: url.origin, "content-type": "application/json" }),
            },
            ...(input === undefined ? {} : { body: JSON.stringify(input) }),
        });
        for (const entry of response.headers.getSetCookie()) {
            const pair = entry.split(";")[0];
            if (!pair) continue;
            const separator = pair.indexOf("=");
            jar.set(pair.slice(0, separator), pair.slice(separator + 1));
        }
        return response;
    }

    try {
        await admin("migrate");
        await admin("create-user", {
            username,
            email: username + "@example.test",
            password,
            groups: ["admins"],
        });
        start("auth", authEnvironment);
        start("dashboard", dashboardEnvironment);
        await Promise.all([ready(issuer), ready(origin)]);
        for (const url of [issuer, origin]) {
            const html = await request(url);
            assert.equal(html.status, 200);
            assert.match(
                html.headers.get("Content-Security-Policy") ?? "",
                /frame-ancestors 'none'/
            );
        }
        let response = await request(origin + "/login");
        const login = await request(issuer + "/api/login", { username, password });
        assert.equal(login.status, 200);
        let callback = false;
        for (let count = 0; count < 14; count += 1) {
            const location = response.headers.get("location");
            assert.ok(location, "OIDC redirect missing");
            const url = new URL(location, issuer);
            if (url.pathname === "/sign-in") {
                const completed = await request(issuer + "/sign-in/complete", {});
                assert.equal(completed.status, 200);
                const payload: unknown = await completed.json();
                response = await request(redirect(payload));
            } else {
                response = await request(url.href);
                if (url.pathname === "/auth/callback") {
                    callback = true;
                    break;
                }
            }
        }
        assert.ok(callback, "Built OIDC callback was not reached");
        assert.equal(response.status, 303);
        const account = await request(origin + "/api/account");
        assert.equal(account.status, 200);
        const logout = await request(origin + "/api/logout", {});
        assert.equal(logout.status, 200);
        const revoked = await request(origin + "/api/account");
        assert.equal(revoked.status, 401);
        console.info(
            "PASS: built migration CLI, separate configured processes, HTML CSP, OIDC exchange, account BFF and logout."
        );
    } finally {
        for (const child of children) child.kill("SIGTERM");
        await Promise.all(
            children.map(async (child) => {
                const timer = setTimeout(() => child.kill("SIGKILL"), 3000);
                try {
                    await child.exited;
                } finally {
                    clearTimeout(timer);
                }
            })
        );
    }
}

if (import.meta.main) await main();
