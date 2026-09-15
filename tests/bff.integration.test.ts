import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";

import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import * as v from "valibot";

import { createAuthApplication } from "../apps/auth/src/server/application";
import type { AuthConfiguration } from "../apps/auth/src/server/config/configuration";
import {
    users,
    sessions,
    mailOutbox,
    rateBuckets,
    oidcRecords,
} from "../apps/auth/src/server/database/schema";
import { hashPassword } from "../apps/auth/src/server/security/crypto";
import { startDashboardServer } from "../apps/dashboard/src/server/index";

describe.each(["client_secret_post", "client_secret_basic"] as const)(
    "BFF with %s",
    (method) => {
        let auth: Awaited<ReturnType<typeof createAuthApplication>>;
        let authServer: ReturnType<typeof Bun.serve>,
            dashboard: ReturnType<typeof startDashboardServer>;
        let issuer: string, origin: string;
        const password = "bff-test-password-not-production";
        const clientSecret = "bff-client-secret-test-only-not-production-32";
        const jar = new Map<string, Map<string, { value: string; path: string }>>();
        async function browser(
            value: string,
            input?: unknown,
            forcedOrigin?: string
        ): Promise<Response> {
            const url = new URL(value);
            const cookies =
                jar.get(url.origin) ?? new Map<string, { value: string; path: string }>();
            jar.set(url.origin, cookies);
            const response = await fetch(url, {
                redirect: "manual",
                method: input === undefined ? "GET" : "POST",
                headers: {
                    cookie: [...cookies]
                        .filter(
                            ([, item]) =>
                                item.path === "/" ||
                                url.pathname === item.path ||
                                url.pathname.startsWith(item.path + "/")
                        )
                        .map(([name, item]) => `${name}=${item.value}`)
                        .join("; "),
                    ...(input === undefined
                        ? {}
                        : {
                              "Content-Type": "application/json",
                              Origin: forcedOrigin ?? url.origin,
                          }),
                },
                ...(input === undefined ? {} : { body: JSON.stringify(input) }),
            });
            for (const header of response.headers.getSetCookie()) {
                const [pair, ...attributes] = header.split(";");
                if (!pair) continue;
                const separator = pair.indexOf("=");
                const path =
                    attributes
                        .find((item) => item.trim().toLowerCase().startsWith("path="))
                        ?.trim()
                        .slice(5) ?? "/";
                cookies.set(pair.slice(0, separator), {
                    value: pair.slice(separator + 1),
                    path,
                });
            }
            return response;
        }
        beforeAll(async () => {
            const databaseUrl = process.env.HOMELAB_TEST_DATABASE_URL;
            if (!databaseUrl) throw new Error("Isolated test database required");
            const target = new URL(databaseUrl);
            if (
                !["localhost", "127.0.0.1"].includes(target.hostname) ||
                target.pathname !== "/homelab_auth_test"
            )
                throw new Error("Refusing non-test database");
            authServer = Bun.serve({
                hostname: "127.0.0.1",
                port: 0,
                fetch: (request) =>
                    auth
                        ? auth.handle(request, "bff-test")
                        : new Response(null, { status: 503 }),
            });
            issuer = `http://127.0.0.1:${authServer.port}`;
            const portProbe = Bun.serve({
                hostname: "127.0.0.1",
                port: 0,
                fetch: () => new Response(null, { status: 503 }),
            });
            const port = portProbe.port;
            if (!port) throw new Error("Port allocation failed");
            await portProbe.stop(true);
            origin = `http://127.0.0.1:${port}`;
            const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
            const configuration: AuthConfiguration = {
                issuer,
                dashboardOrigin: origin,
                databaseUrl,
                development: true,
                encryptionKey: crypto.getRandomValues(new Uint8Array(32)),
                cookieKey: "bff-test-cookie-key-not-production-at-least-43-characters",
                proxyKey: "bff-test-proxy-key-not-production-at-least-43-characters",
                rpId: "localhost",
                origins: [issuer, origin],
                clients: [
                    {
                        client_id: "dashboard",
                        client_secret: clientSecret,
                        client_name: "Dashboard test",
                        redirect_uris: [`${origin}/auth/callback`],
                        response_types: ["code"],
                        grant_types: ["authorization_code", "refresh_token"],
                        token_endpoint_auth_method: method,
                        scope: "openid profile email groups account",
                    },
                ],
                dashboardClientId: "dashboard",
                jwks: {
                    keys: [
                        {
                            ...privateKey.export({ format: "jwk" }),
                            kid: "bff-test-key",
                            alg: "RS256",
                            use: "sig",
                        },
                    ],
                },
                routes: [],
                resendKey: undefined,
                emailFrom: "Test <noreply@example.test>",
            };
            auth = await createAuthApplication(configuration, () => Promise.resolve());
            await migrate(auth.connection.database, {
                migrationsFolder: new URL("../apps/auth/migrations/", import.meta.url)
                    .pathname,
            });
            await auth.connection.database.delete(users);
            await auth.connection.database.delete(mailOutbox);
            await auth.connection.database.delete(rateBuckets);
            await auth.connection.database.delete(oidcRecords);
            await auth.connection.database.insert(users).values({
                id: crypto.randomUUID(),
                username: "bff-operator",
                email: "bff@example.test",
                emailVerified: true,
                passwordHash: await hashPassword(password),
                groups: ["admins"],
                createdAt: new Date(),
            });
            dashboard = startDashboardServer({
                hostname: "127.0.0.1",
                port,
                development: false,
                authentication: {
                    issuer,
                    origin,
                    clientId: "dashboard",
                    clientSecret,
                    tokenEndpointAuthMethod: method,
                    sessionKey: crypto.getRandomValues(new Uint8Array(32)),
                    development: true,
                },
            });
        });
        afterAll(async () => {
            await dashboard?.stop(true);
            await auth?.close();
            await authServer?.stop(true);
        });
        async function signIn(): Promise<string> {
            const login = await browser(`${issuer}/api/login`, {
                username: "bff-operator",
                password,
            });
            expect(login.status).toBe(200);
            let response = await browser(`${origin}/login?returnTo=/settings`);
            for (let count = 0; count < 12; count += 1) {
                const location = response.headers.get("Location");
                if (!location) throw new Error("OIDC redirect missing");
                const next = new URL(location, issuer);
                if (next.origin === origin && next.pathname === "/auth/callback") {
                    const callback = await browser(next.href);
                    expect(callback.status).toBe(303);
                    expect(callback.headers.get("Location")).toBe("/settings");
                    return next.href;
                }
                if (next.pathname === "/sign-in") {
                    const interaction = await browser(`${issuer}/sign-in/complete`, {});
                    expect(interaction.status).toBe(200);
                    const data = v.parse(
                        v.object({ redirect: v.string() }),
                        await interaction.json()
                    );
                    response = await browser(data.redirect);
                } else response = await browser(next.href);
            }
            throw new Error("OIDC redirect limit reached");
        }
        describe("independent dashboard BFF and identity service", () => {
            test("requires identity before the private API and validates a complete OIDC login", async () => {
                const unauthorized = await browser(`${origin}/api/account`);
                expect(unauthorized.status).toBe(401);
                await signIn();
                const response = await browser(`${origin}/api/account`);
                expect(response.status).toBe(200);
                const account = v.parse(
                    v.object({ user: v.object({ username: v.string() }) }),
                    await response.json()
                );
                expect(account.user.username).toBe("bff-operator");
                const cookie = jar.get(origin)?.get("homelab_dashboard")?.value;
                expect(cookie?.split(".")).toHaveLength(5);
                expect(cookie).not.toContain("bff-operator");
            });
            test("renews activity for private API calls, not passive session polling", async () => {
                const [session] = await auth.connection.database.select().from(sessions);
                if (!session) throw new Error("Session missing");
                const lastSeen = new Date(Date.now() - 55 * 60_000);
                await auth.connection.database
                    .update(sessions)
                    .set({ lastSeenAt: lastSeen })
                    .where(eq(sessions.id, session.id));
                const passive = await browser(`${origin}/api/session`);
                expect(passive.status).toBe(200);
                const [unchanged] = await auth.connection.database
                    .select()
                    .from(sessions)
                    .where(eq(sessions.id, session.id));
                expect(unchanged?.lastSeenAt.getTime()).toBe(lastSeen.getTime());
                const active = await browser(`${origin}/api/trpc/system.status`);
                expect(active.status).toBe(200);
                const [renewed] = await auth.connection.database
                    .select()
                    .from(sessions)
                    .where(eq(sessions.id, session.id));
                expect(renewed?.lastSeenAt.getTime()).toBeGreaterThan(lastSeen.getTime());
            });

            test("rejected tRPC origins cannot renew the central session", async () => {
                const [session] = await auth.connection.database.select().from(sessions);
                if (!session) throw new Error("Session missing");
                const lastSeen = new Date(Date.now() - 55 * 60_000);
                await auth.connection.database
                    .update(sessions)
                    .set({ lastSeenAt: lastSeen })
                    .where(eq(sessions.id, session.id));
                const cookie = jar.get(origin)?.get("homelab_dashboard")?.value;
                if (!cookie) throw new Error("Dashboard cookie missing");
                for (const requestOrigin of [
                    "http://sibling.example.test",
                    "null",
                    undefined,
                ]) {
                    const rejected = await fetch(origin + "/api/trpc/system.status", {
                        method: "POST",
                        headers: {
                            Cookie: "homelab_dashboard=" + cookie,
                            "Content-Type": "application/x-www-form-urlencoded",
                            ...(requestOrigin ? { Origin: requestOrigin } : {}),
                        },
                        body: "input={}",
                    });
                    expect(rejected.status).toBe(403);
                    const [unchanged] = await auth.connection.database
                        .select()
                        .from(sessions)
                        .where(eq(sessions.id, session.id));
                    expect(unchanged?.lastSeenAt.getTime()).toBe(lastSeen.getTime());
                }
            });
            test("uses server-side step-up and rejects a forged dashboard origin", async () => {
                const bad = await browser(
                    `${origin}/api/account/email`,
                    { email: "forged@example.test" },
                    "https://attacker.example"
                );
                expect(bad.status).toBe(403);
                const [session] = await auth.connection.database.select().from(sessions);
                if (!session) throw new Error("Session missing");
                await auth.connection.database
                    .update(sessions)
                    .set({ passwordAt: new Date(Date.now() - 600_000) })
                    .where(eq(sessions.id, session.id));
                const rejected = await browser(`${origin}/api/account/email`, {
                    email: "changed@example.test",
                });
                expect(rejected.status).toBe(403);
                const failure = v.parse(
                    v.object({ code: v.string() }),
                    await rejected.json()
                );
                expect(failure.code).toBe("STEP_UP_REQUIRED");
                const proof = await browser(`${origin}/api/account/proof/password`, {
                    password,
                });
                expect(proof.status).toBe(200);
                const retried = await browser(`${origin}/api/account/email`, {
                    email: "changed@example.test",
                });
                expect(retried.status).toBe(200);
            });
            test("logout invalidates the central session and re-login works with old provider cookies", async () => {
                const logout = await browser(`${origin}/api/logout`, {});
                expect(logout.status).toBe(200);
                const denied = await browser(`${origin}/api/account`);
                expect(denied.status).toBe(401);
                await signIn();
                const accepted = await browser(`${origin}/api/account`);
                expect(accepted.status).toBe(200);
            });
            test("does not revive an idle-expired central session", async () => {
                const sessionData = await browser(`${origin}/api/account`);
                expect(sessionData.status).toBe(200);
                const [session] = await auth.connection.database.select().from(sessions);
                if (!session) throw new Error("Session missing");
                const lastSeen = new Date(Date.now() - 61 * 60_000);
                await auth.connection.database
                    .update(sessions)
                    .set({ lastSeenAt: lastSeen })
                    .where(eq(sessions.id, session.id));
                const response = await browser(`${origin}/api/trpc/system.status`);
                expect(response.status).toBe(401);
                const [unchanged] = await auth.connection.database
                    .select()
                    .from(sessions)
                    .where(eq(sessions.id, session.id));
                expect(unchanged?.lastSeenAt.getTime()).toBe(lastSeen.getTime());
                await signIn();
            });
            test("rejects a tampered dashboard session instead of exposing account data", async () => {
                jar.get(origin)?.set("homelab_dashboard", {
                    value: "tampered",
                    path: "/",
                });
                const rejected = await browser(`${origin}/api/account`);
                expect(rejected.status).toBe(401);
            });
        });
    }
);
