import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";

import { oidcInteractionSchema, type OidcConsent } from "@homelab/contracts";
import { eq, sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { createLocalJWKSet, decodeJwt, jwtVerify } from "jose";
import { TOTP } from "otpauth";
import * as v from "valibot";

import { createTestDatabase } from "../../../../../tests/database";
import { createAuthApplication } from "../application";
import type { AuthConfiguration } from "../config/configuration";
import { requiredAuthMigrations } from "../database/migrations";
import {
    auditEvents,
    factors,
    grantSessions,
    logoutOutbox,
    sessions,
    users,
    mailOutbox,
    rateBuckets,
    oidcRecords,
    challenges,
    recoveryCodes,
} from "../database/schema";
import { deliverLogouts } from "../oidc/logout";
import { encryptValue, hashPassword, tokenDigest } from "../security/crypto";
import type { AuthEmail } from "../security/email";
import { softwareAuthenticator } from "../testing/webauthnFixture";

let testDatabase: Awaited<ReturnType<typeof createTestDatabase>>;
let application: Awaited<ReturnType<typeof createAuthApplication>>;
let server: ReturnType<typeof Bun.serve>;
let issuer: string;
const delivered: AuthEmail[] = [];
const password = "isolated-test-password-not-production";
const clientSecret = "isolated-client-secret-for-tests-only-32-characters";
let logoutServer: ReturnType<typeof Bun.serve>;
const logoutTokens: string[] = [];
let logoutStatus = 204;
const cookieJar = new Map<string, { value: string; path: string }>();

async function browser(path: string, options: RequestInit = {}): Promise<Response> {
    const target = new URL(path, issuer);
    const headers = new Headers(options.headers);
    const cookie = [...cookieJar.entries()]
        .filter(
            ([, entry]) =>
                target.pathname === entry.path ||
                target.pathname.startsWith(
                    entry.path.endsWith("/") ? entry.path : `${entry.path}/`
                )
        )
        .map(([name, entry]) => `${name}=${entry.value}`)
        .join("; ");
    if (cookie && !headers.has("cookie")) headers.set("cookie", cookie);
    const response = await fetch(target, { ...options, headers, redirect: "manual" });
    for (const entry of response.headers.getSetCookie()) {
        const [pair, ...attributes] = entry.split(";");
        if (!pair) continue;
        const separator = pair.indexOf("=");
        const name = pair.slice(0, separator);
        const value = pair.slice(separator + 1);
        const pathAttribute = attributes.find((attribute) =>
            attribute.trim().toLowerCase().startsWith("path=")
        );
        cookieJar.set(name, { value, path: pathAttribute?.trim().slice(5) ?? "/" });
    }
    return response;
}

function post(path: string, body: unknown): Promise<Response> {
    return browser(path, {
        method: "POST",
        headers: { "content-type": "application/json", origin: issuer },
        body: JSON.stringify(body),
    });
}

beforeAll(async () => {
    logoutServer = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
            const body = new URLSearchParams(await request.text());
            const token = body.get("logout_token");
            if (request.method !== "POST" || !token)
                return new Response(null, { status: 400 });
            logoutTokens.push(token);
            return new Response(null, { status: logoutStatus });
        },
    });
    testDatabase = await createTestDatabase();
    const databaseUrl = testDatabase.url;
    if (!databaseUrl)
        throw new Error(
            "HOMELAB_TEST_DATABASE_URL must point to the isolated test database"
        );
    const target = new URL(databaseUrl);
    if (
        !["localhost", "127.0.0.1"].includes(target.hostname) ||
        !target.pathname.startsWith("/homelab_test_")
    )
        throw new Error("Refusing to use a non-test database");
    server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        maxRequestBodySize: 65_536,
        fetch: (request) =>
            application
                ? application.handle(request, "integration-test")
                : new Response(null, { status: 503 }),
    });
    issuer = `http://127.0.0.1:${server.port}`;
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const configuration: AuthConfiguration = {
        issuer,
        dashboardOrigin: issuer,
        databaseUrl,
        development: true,
        encryptionKey: crypto.getRandomValues(new Uint8Array(32)),
        cookieKey: "isolated-cookie-key-for-tests-only-at-least-43-characters",
        proxyKey: "isolated-proxy-key-for-tests-only-at-least-43-characters",
        rpId: "localhost",
        origins: [issuer],
        clients: [
            {
                client_id: "dashboard",
                client_secret: clientSecret,
                client_name: "Test Dashboard",
                backchannel_logout_uri: `http://127.0.0.1:${logoutServer.port}/logout`,
                backchannel_logout_session_required: true,
                redirect_uris: [`${issuer}/callback`],
                response_types: ["code"],
                grant_types: ["authorization_code", "refresh_token"],
                token_endpoint_auth_method: "client_secret_post",
                scope: "openid profile email groups account offline_access",
                post_logout_redirect_uris: [`${issuer}/signed-out`],
            },
            {
                client_id: "basic-client",
                client_secret: clientSecret,
                client_name: "Basic authentication client",
                redirect_uris: [`${issuer}/callback`],
                response_types: ["code"],
                grant_types: ["authorization_code", "refresh_token"],
                token_endpoint_auth_method: "client_secret_basic",
                scope: "openid profile email groups offline_access",
            },
        ],
        dashboardClientId: "dashboard",
        jwks: {
            keys: [
                {
                    ...privateKey.export({ format: "jwk" }),
                    kid: "test-key",
                    alg: "RS256",
                    use: "sig",
                },
            ],
        },
        routes: [
            {
                origin: "https://tools.example.test",
                publicPaths: ["/manifest.webmanifest"],
                publicPrefixes: ["/public/"],
                groups: ["admins"],
            },
        ],
        resendKey: undefined,
        emailFrom: "Homelab Test <noreply@example.test>",
    };
    application = await createAuthApplication(configuration, (_id, message) => {
        delivered.push(message);
        return Promise.resolve();
    });
    await migrate(application.connection.database, {
        migrationsFolder: new URL("../../../migrations", import.meta.url).pathname,
    });
    await application.connection.database.delete(users);
    await application.connection.database.delete(mailOutbox);
    await application.connection.database.delete(rateBuckets);
    await application.connection.database.delete(oidcRecords);
    await application.connection.database.insert(users).values({
        id: crypto.randomUUID(),
        username: "testoperator",
        email: "operator@example.test",
        emailVerified: true,
        passwordHash: await hashPassword(password),
        groups: ["admins"],
        createdAt: new Date(),
    });
}, 30_000);

afterAll(async () => {
    await application?.close();
    await server?.stop(true);
    await logoutServer?.stop(true);
    await testDatabase?.close();
});

describe("identity service with PostgreSQL and Bun", () => {
    test("rejects spoofed origins before creating a session", async () => {
        const response = await browser("/api/login", {
            method: "POST",
            headers: {
                "content-type": "application/json",
                origin: "https://attacker.example",
            },
            body: JSON.stringify({ username: "testoperator", password }),
        });
        expect(response.status).toBe(403);
        expect(
            await application.connection.database.select().from(sessions)
        ).toHaveLength(0);
    });

    test("logs in, lists the current session, and never returns password hashes", async () => {
        expect(
            await status(post("/api/login", { username: "testoperator", password }))
        ).toBe(200);
        const response = await browser("/api/account");
        expect(response.status).toBe(200);
        const value = v.parse(
            v.object({
                user: v.object({
                    username: v.string(),
                    passwordHash: v.optional(v.string()),
                }),
                sessions: v.array(v.object({ current: v.boolean() })),
            }),
            await response.json()
        );
        expect(value.user.username).toBe("testoperator");
        expect(value.user.passwordHash).toBeUndefined();
        expect(value.sessions).toHaveLength(1);
        expect(value.sessions[0]?.current).toBe(true);
    });

    test("blocks stale-proof mutations without changing data and accepts retry after proof", async () => {
        const [session] = await application.connection.database.select().from(sessions);
        if (!session) throw new Error("Test session missing");
        await application.connection.database
            .update(sessions)
            .set({ passwordAt: new Date(Date.now() - 600_000) })
            .where(eq(sessions.id, session.id));
        const before = await application.connection.database.select().from(factors);
        const rejected = await post("/api/account/totp/begin", {
            label: "Test authenticator",
        });
        expect(rejected.status).toBe(403);
        expect(v.parse(v.object({ code: v.string() }), await rejected.json()).code).toBe(
            "STEP_UP_REQUIRED"
        );
        expect(await application.connection.database.select().from(factors)).toEqual(
            before
        );
        expect(await status(post("/api/account/proof/password", { password }))).toBe(200);
        const enrollment = await post("/api/account/totp/begin", {
            label: "Test authenticator",
        });
        expect(enrollment.status).toBe(200);
        const data = v.parse(
            v.object({ secret: v.string(), token: v.string() }),
            await enrollment.json()
        );
        const code = new TOTP({ secret: data.secret }).generate();
        const confirmed = await post("/api/account/totp/finish", {
            token: data.token,
            code,
        });
        expect(confirmed.status).toBe(200);
        expect(
            v.parse(
                v.object({ recoveryCodes: v.array(v.string()) }),
                await confirmed.json()
            ).recoveryCodes
        ).toHaveLength(10);
        expect(
            await status(post("/api/account/totp/finish", { token: data.token, code }))
        ).toBe(400);
        expect(await status(post("/api/account/proof/totp", { code }))).toBe(400);
    });

    test("verifies email once and keeps a pending change from replacing the current address", async () => {
        expect(
            await status(
                post("/api/account/email", { email: "replacement@example.test" })
            )
        ).toBe(200);
        expect(
            v.parse(
                v.object({ user: v.object({ email: v.string() }) }),
                await responseJson(browser("/api/account"))
            ).user.email
        ).toBe("operator@example.test");
        await application.services.email.deliverPending();
        const message = delivered.find(
            (entry) => entry.to === "replacement@example.test"
        );
        const token = message?.text.match(/#token=([\w-]{43})/)?.[1];
        if (!token) throw new Error("Verification email was not delivered");
        expect(await status(post("/api/email/verify", { token }))).toBe(200);
        expect(await status(post("/api/email/verify", { token }))).toBe(400);
        expect(
            v.parse(
                v.object({ user: v.object({ email: v.string() }) }),
                await responseJson(browser("/api/account"))
            ).user.email
        ).toBe("replacement@example.test");
    });

    test("completes OIDC authorization code with S256 and rejects reuse", async () => {
        const verifier = "isolated-pkce-verifier-for-tests-at-least-43-characters";
        const challenge = Buffer.from(
            await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
        ).toString("base64url");
        const params = new URLSearchParams({
            client_id: "dashboard",
            redirect_uri: `${issuer}/callback`,
            response_type: "code",
            scope: "openid profile email groups account",
            state: "test-state",
            nonce: "test-nonce",
            code_challenge: challenge,
            code_challenge_method: "S256",
        });
        let response = await browser(`/authorize?${params.toString()}`);
        let code: string | null = null;
        for (let index = 0; index < 10; index += 1) {
            const location = response.headers.get("location");
            if (!location)
                throw new Error(
                    `Authorization did not redirect: ${response.status} ${await response.text()}`
                );
            const url = new URL(location, issuer);
            if (url.pathname === "/callback") {
                code = url.searchParams.get("code");
                expect(url.searchParams.get("state")).toBe("test-state");
                break;
            }
            if (url.pathname === "/sign-in") {
                const next = await approveTestInteraction();
                response = await browser(next.redirect);
            } else response = await browser(url.href);
        }
        expect(code).toBeTruthy();
        const exchange = () =>
            browser("/token", {
                method: "POST",
                headers: { "content-type": "application/x-www-form-urlencoded" },
                body: new URLSearchParams({
                    client_id: "dashboard",
                    client_secret: clientSecret,
                    grant_type: "authorization_code",
                    code: code ?? "",
                    code_verifier: verifier,
                    redirect_uri: `${issuer}/callback`,
                }).toString(),
            });
        const first = await exchange();
        if (first.status !== 200)
            throw new Error(`Token exchange failed: ${await first.text()}`);
        const tokens = v.parse(
            v.object({ id_token: v.string(), access_token: v.string() }),
            await first.json()
        );
        expect(typeof tokens.id_token).toBe("string");
        const account = await browser("/api/account", {
            headers: { authorization: `Bearer ${tokens.access_token}` },
        });
        expect(account.status).toBe(200);
        expect(await status(exchange())).toBe(400);
        expect(
            await status(
                browser("/api/account", {
                    headers: { authorization: `Bearer ${tokens.access_token}` },
                })
            )
        ).toBe(401);
    });

    test("revokes the central session and makes its opaque token unusable", async () => {
        const token = cookieJar.get("homelab_auth")?.value;
        if (!token) throw new Error("Test session token missing");
        expect(await status(post("/api/logout", {}))).toBe(200);
        expect(
            await application.connection.database
                .select()
                .from(sessions)
                .where(eq(sessions.tokenHash, tokenDigest(token)))
        ).toHaveLength(0);
        expect(await status(browser("/api/account"))).toBe(401);
    });
});

const enrollmentSchema = v.object({ token: v.string(), secret: v.string() });
const credentialOptions = v.object({
    id: v.string(),
    transports: v.optional(v.array(v.string())),
});
const webauthnOptionsSchema = v.object({
    token: v.string(),
    options: v.object({
        challenge: v.string(),
        allowCredentials: v.optional(v.array(credentialOptions)),
    }),
});
async function status(response: Promise<Response>): Promise<number> {
    const result = await response;
    return result.status;
}
async function json<TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
    response: Promise<Response>,
    schema: TSchema
): Promise<v.InferOutput<TSchema>> {
    const result = await response;
    return v.parse(schema, await result.json());
}
async function enrollTotp() {
    const setup = await json(
        post("/api/account/totp/begin", { label: "Integration authenticator" }),
        enrollmentSchema
    );
    const codes = await json(
        post("/api/account/totp/finish", {
            token: setup.token,
            code: new TOTP({ secret: setup.secret }).generate(),
        }),
        v.object({ recoveryCodes: v.array(v.string()) })
    );
    return { ...setup, codes: codes.recoveryCodes };
}
function proxyRequest(
    uri: string,
    cookie?: string,
    trusted = true,
    activity: Record<string, string> = {}
) {
    return browser("/api/authz/forward-auth", {
        headers: {
            "x-forwarded-proto": "https",
            "x-forwarded-host": "tools.example.test",
            "x-forwarded-uri": uri,
            ...(trusted
                ? {
                      "x-homelab-proxy-key":
                          application.services.accounts.configuration.proxyKey,
                  }
                : {}),
            ...(cookie ? { cookie } : {}),
            "Remote-User": "spoofed-admin",
            ...activity,
        },
    });
}

describe("security invariants against the isolated database", () => {
    let username: string;
    beforeEach(async () => {
        cookieJar.clear();
        logoutTokens.length = 0;
        logoutStatus = 204;
        await application.connection.database.delete(logoutOutbox);
        await application.connection.database.delete(rateBuckets);
        username = `operator-${crypto.randomUUID()}`;
        await application.connection.database.insert(users).values({
            id: crypto.randomUUID(),
            username,
            email: `${username}@example.test`,
            emailVerified: true,
            passwordHash: await hashPassword(password),
            groups: ["admins"],
            createdAt: new Date(),
        });
        expect(await status(post("/api/login", { username, password }))).toBe(200);
    });

    test("audit pagination is stable across tied timestamps and never includes another account", async () => {
        const database = application.connection.database;
        const [user] = await database
            .select()
            .from(users)
            .where(eq(users.username, username));
        if (!user) throw new Error("Fixture account missing");
        await database.delete(auditEvents).where(eq(auditEvents.userId, user.id));
        const timestamp = new Date("2026-09-15T12:00:00.000Z");
        const rows = Array.from({ length: 57 }, () => ({
            id: crypto.randomUUID(),
            userId: user.id,
            event: "password_changed",
            createdAt: timestamp,
        }));
        await database.insert(auditEvents).values(rows);
        await database.insert(auditEvents).values({
            id: crypto.randomUUID(),
            userId: null,
            event: "unrelated_event",
            createdAt: timestamp,
        });
        const schema = v.object({
            events: v.array(v.object({ id: v.string(), account: v.string() })),
            nextCursor: v.nullable(v.string()),
        });
        const first = await json(browser("/api/account/activity"), schema);
        expect(first.events).toHaveLength(50);
        expect(first.nextCursor).not.toBeNull();
        const second = await json(
            browser(
                "/api/account/activity?cursor=" +
                    encodeURIComponent(first.nextCursor ?? "")
            ),
            schema
        );
        expect(second.events).toHaveLength(7);
        expect(second.nextCursor).toBeNull();
        expect(
            [...first.events, ...second.events].every(
                (event) => event.account === username
            )
        ).toBe(true);
        expect(
            new Set([...first.events, ...second.events].map((event) => event.id)).size
        ).toBe(57);
        expect([...first.events, ...second.events].map((event) => event.id)).toEqual(
            rows
                .map((row) => row.id)
                .toSorted()
                .toReversed()
        );
        expect(await status(browser("/api/account/activity?cursor=invalid"))).toBe(400);
        await post("/api/logout", {});
        expect(await status(browser("/api/account/activity"))).toBe(401);
    });

    test("disabling two-step login requires fresh MFA and the password, then revokes all factors and sessions", async () => {
        await enrollTotp();
        const tokens = await authorizationTokens(
            "openid profile groups account offline_access"
        );
        const database = application.connection.database;
        const [user] = await database
            .select()
            .from(users)
            .where(eq(users.username, username));
        if (!user) throw new Error("Fixture account missing");
        const [session] = await database
            .select()
            .from(sessions)
            .where(eq(sessions.userId, user.id));
        if (!session) throw new Error("Fixture session missing");
        await database
            .update(sessions)
            .set({ mfaAt: new Date(Date.now() - 600_000) })
            .where(eq(sessions.id, session.id));
        expect(await status(post("/api/account/mfa/disable", { password }))).toBe(403);
        await database
            .update(sessions)
            .set({ mfaAt: new Date() })
            .where(eq(sessions.id, session.id));
        expect(
            await status(
                post("/api/account/mfa/disable", { password: "incorrect-password" })
            )
        ).toBe(400);
        expect(
            await database.select().from(factors).where(eq(factors.userId, user.id))
        ).toHaveLength(1);
        const second = await application.services.accounts.login(
            username,
            password,
            "disable-mfa-fixture",
            "Other fixture browser"
        );
        expect(second.mfaRequired).toBe(true);
        expect(await status(post("/api/account/mfa/disable", { password }))).toBe(200);
        for (const table of [factors, recoveryCodes, challenges, sessions])
            expect(
                await database.select().from(table).where(eq(table.userId, user.id))
            ).toHaveLength(0);
        expect(await status(browser("/api/account"))).toBe(401);
        expect(
            await status(
                browser("/userinfo", {
                    headers: { authorization: `Bearer ${tokens.access_token}` },
                })
            )
        ).toBe(401);
        expect(
            await deliverLogouts(
                database,
                application.services.accounts.configuration,
                application.services.provider
            )
        ).toBeGreaterThan(0);
        expect(await status(post("/api/login", { username, password }))).toBe(200);
        const result = await json(
            browser("/api/session"),
            v.object({ authenticated: v.boolean(), methods: v.array(v.string()) })
        );
        expect(result).toEqual({ authenticated: true, methods: [] });
        const redirected = await proxyRequest("/private");
        expect(redirected.status).toBe(302);
        const target = new URL(redirected.headers.get("location") ?? "");
        expect(
            await status(
                post("/api/sso/complete", {
                    target: target.searchParams.get("target"),
                    nonce: target.searchParams.get("nonce"),
                })
            )
        ).toBe(403);
    });

    test("delivers signed session-specific logout after Settings revokes only the old device", async () => {
        const old = await authorizationTokens("openid profile");
        const oldSid = decodeJwt(old.id_token).sid;
        const snapshot = await json(
            browser("/api/account"),
            v.object({
                sessions: v.array(v.object({ id: v.string(), current: v.boolean() })),
            })
        );
        const oldSession = snapshot.sessions.find((session) => session.current);
        if (!oldSession) throw new Error("Current session missing");
        expect(await status(post("/api/login", { username, password }))).toBe(200);
        const current = await authorizationTokens("openid profile");
        const newSid = decodeJwt(current.id_token).sid;
        expect(typeof oldSid).toBe("string");
        expect(newSid).not.toBe(oldSid);
        expect(
            await status(post("/api/account/session/revoke", { id: oldSession.id }))
        ).toBe(200);
        expect(
            await deliverLogouts(
                application.connection.database,
                application.services.accounts.configuration,
                application.services.provider
            )
        ).toBe(1);
        const token = logoutTokens.at(-1);
        if (!token) throw new Error("Logout not delivered");
        const keysResponse = await browser("/jwks");
        const keys = v.parse(
            v.object({ keys: v.array(v.record(v.string(), v.unknown())) }),
            await keysResponse.json()
        );
        const { payload } = await jwtVerify(token, createLocalJWKSet(keys), {
            issuer,
            audience: "dashboard",
        });
        expect(payload.sid).toBe(oldSid);
        expect(payload.sid).not.toBe(newSid);
        expect(payload.sub).toBe(decodeJwt(old.id_token).sub);
        expect(payload.events).toEqual({
            "http://schemas.openid.net/event/backchannel-logout": {},
        });
        expect(payload.nonce).toBeUndefined();
        expect(typeof payload.jti).toBe("string");
        expect(
            await status(
                browser("/userinfo", {
                    headers: { authorization: "Bearer " + old.access_token },
                })
            )
        ).toBe(401);
        expect(
            await status(
                browser("/userinfo", {
                    headers: { authorization: "Bearer " + current.access_token },
                })
            )
        ).toBe(200);
        expect(await status(browser("/api/account"))).toBe(200);
    });

    test("retries unavailable logout endpoints without restoring the revoked session", async () => {
        await authorizationTokens("openid profile");
        logoutStatus = 503;
        expect(await status(post("/api/logout", {}))).toBe(200);
        expect(
            await deliverLogouts(
                application.connection.database,
                application.services.accounts.configuration,
                application.services.provider
            )
        ).toBe(0);
        expect(await status(browser("/api/account"))).toBe(401);
        const queued = await application.connection.database.select().from(logoutOutbox);
        expect(queued).toHaveLength(1);
        expect(queued[0]?.attempts).toBe(1);
        expect(queued[0]?.encryptedData).not.toContain("http:");
        logoutStatus = 204;
        await application.connection.database
            .update(logoutOutbox)
            .set({ nextAttemptAt: new Date(0) });
        expect(
            await deliverLogouts(
                application.connection.database,
                application.services.accounts.configuration,
                application.services.provider
            )
        ).toBe(1);
        expect(
            await application.connection.database.select().from(logoutOutbox)
        ).toHaveLength(0);
    });

    test("queued logout accepts equivalent endpoint spelling but rejects changed destinations", async () => {
        await authorizationTokens("openid profile");
        expect(await status(post("/api/logout", {}))).toBe(200);
        const configuration = application.services.accounts.configuration;
        const client = configuration.clients.find(
            (entry) => entry.client_id === "dashboard"
        );
        const uri = client?.backchannel_logout_uri;
        if (!client || !uri) throw new Error("Logout fixture missing");
        const withUri = (replacement: string | undefined): AuthConfiguration => ({
            ...configuration,
            clients: configuration.clients.map((entry) =>
                entry === client
                    ? { ...entry, backchannel_logout_uri: replacement }
                    : entry
            ),
        });
        for (const changed of [
            undefined,
            uri + "/changed",
            uri + "?changed=true",
            uri.replace("127.0.0.1", "localhost"),
            uri.replace("http:", "https:"),
        ]) {
            await application.connection.database
                .update(logoutOutbox)
                .set({ nextAttemptAt: new Date(0) });
            expect(
                await deliverLogouts(
                    application.connection.database,
                    withUri(changed),
                    application.services.provider
                )
            ).toBe(0);
            expect(logoutTokens).toHaveLength(0);
        }
        await application.connection.database
            .update(logoutOutbox)
            .set({ nextAttemptAt: new Date(0) });
        expect(
            await deliverLogouts(
                application.connection.database,
                withUri(uri.replace("http:", "HTTP:")),
                application.services.provider
            )
        ).toBe(1);
        expect(logoutTokens).toHaveLength(1);
        expect(
            await application.connection.database.select().from(logoutOutbox)
        ).toHaveLength(0);
    });

    test("logout queue rolls back with revocation and expires with a redacted failure event", async () => {
        await authorizationTokens("openid profile");
        const token = cookieJar.get("homelab_auth")?.value;
        if (!token) throw new Error("Test auth cookie missing");
        const principal = await application.services.accounts.principalByToken(token);
        await application.connection.database
            .transaction(async (transaction) => {
                await application.services.accounts.revoke(
                    transaction,
                    principal.session.id
                );
                throw new Error("Test rollback");
            })
            .then(
                () => {
                    throw new Error("Expected rollback");
                },
                (error: unknown) => {
                    expect(String(error)).toContain("Test rollback");
                }
            );
        expect(
            await application.connection.database.select().from(logoutOutbox)
        ).toHaveLength(0);
        expect(await status(browser("/api/account"))).toBe(200);
        expect(await status(post("/api/logout", {}))).toBe(200);
        await application.connection.database
            .update(logoutOutbox)
            .set({ expiresAt: new Date(0) });
        expect(
            await deliverLogouts(
                application.connection.database,
                application.services.accounts.configuration,
                application.services.provider
            )
        ).toBe(0);
        expect(logoutTokens).toHaveLength(0);
        expect(
            await application.connection.database.select().from(logoutOutbox)
        ).toHaveLength(0);
    });

    test("readiness rejects missing or changed migration records without migrating automatically", async () => {
        const database = application.connection.database;
        const migration = requiredAuthMigrations().at(-1);
        if (!migration?.name) throw new Error("Migration fixture missing");
        expect(await status(browser("/health/ready"))).toBe(200);
        await database.execute(
            sql`DELETE FROM drizzle.__drizzle_migrations WHERE name = ${migration.name}`
        );
        try {
            expect(await status(browser("/health/ready"))).toBe(503);
            expect(await status(browser("/health/live"))).toBe(200);
        } finally {
            await database.execute(sql`INSERT INTO drizzle.__drizzle_migrations (name, hash, created_at)
                VALUES (${migration.name}, ${migration.hash}, ${migration.folderMillis})`);
        }
        await database.execute(
            sql`UPDATE drizzle.__drizzle_migrations SET hash = 'outdated-test-hash' WHERE name = ${migration.name}`
        );
        try {
            expect(await status(browser("/health/ready"))).toBe(503);
        } finally {
            await database.execute(
                sql`UPDATE drizzle.__drizzle_migrations SET hash = ${migration.hash} WHERE name = ${migration.name}`
            );
        }
        expect(await status(browser("/health/ready"))).toBe(200);
    });

    test("successful password proof and account mutations renew idle time, rejected actions do not", async () => {
        const accounts = application.services.accounts;
        const principal = await accounts.principalByToken(
            cookieJar.get("homelab_auth")?.value ?? ""
        );
        const old = new Date(Date.now() - 600_000);
        await accounts.database
            .update(sessions)
            .set({ lastSeenAt: old, passwordAt: old })
            .where(eq(sessions.id, principal.session.id));
        expect(
            await status(
                post("/api/account/proof/password", { password: "wrong-test-password" })
            )
        ).toBe(400);
        const rejected = await accounts.principalById(principal.session.id);
        expect(rejected.session.lastSeenAt.getTime()).toBe(old.getTime());
        expect(await status(post("/api/account/proof/password", { password }))).toBe(200);
        const proven = await accounts.principalById(principal.session.id);
        expect(proven.session.lastSeenAt.getTime()).toBeGreaterThan(old.getTime());
        await accounts.database
            .update(sessions)
            .set({ lastSeenAt: old })
            .where(eq(sessions.id, principal.session.id));
        expect(
            await status(
                post("/api/account/email", { email: username + "@example.test" })
            )
        ).toBe(200);
        const active = await accounts.principalById(principal.session.id);
        expect(active.session.lastSeenAt.getTime()).toBeGreaterThan(old.getTime());
    });

    test("session inspection exposes a stable identifier that changes on a new login", async () => {
        const shape = v.object({ userId: v.string(), sessionId: v.string() });
        const first = await json(browser("/api/session"), shape);
        const again = await json(browser("/api/session"), shape);
        expect(again).toEqual(first);
        expect(await status(post("/api/logout", {}))).toBe(200);
        expect(await status(post("/api/login", { username, password }))).toBe(200);
        const replacement = await json(browser("/api/session"), shape);
        expect(replacement.userId).toBe(first.userId);
        expect(replacement.sessionId).not.toBe(first.sessionId);
    });

    test("account snapshots never renew idle time, including same-site cross-origin GETs", async () => {
        const digest = tokenDigest(cookieJar.get("homelab_auth")?.value ?? "");
        const original = new Date(Date.now() - 600_000);
        await application.connection.database
            .update(sessions)
            .set({ lastSeenAt: original })
            .where(eq(sessions.tokenHash, digest));
        for (const headers of [
            {},
            { "Sec-Fetch-Site": "same-site", Origin: "https://sibling.example.test" },
            { "Sec-Fetch-Site": "same-origin" },
        ]) {
            expect(await status(browser("/api/account", { headers }))).toBe(200);
            const [session] = await application.connection.database
                .select()
                .from(sessions)
                .where(eq(sessions.tokenHash, digest));
            expect(session?.lastSeenAt.getTime()).toBe(original.getTime());
        }
    });

    test("distributed reset requests cannot starve authenticated verification mail", async () => {
        await application.connection.database.delete(mailOutbox);
        const attempts = await Promise.all(
            Array.from({ length: 12 }, (_, index) =>
                application.services.email
                    .requestReset("unknown-" + index, "remote-" + index)
                    .then(
                        () => true,
                        () => false
                    )
            )
        );
        expect(attempts.filter(Boolean)).toHaveLength(4);
        expect(
            await application.connection.database.select().from(mailOutbox)
        ).toHaveLength(4);
        const before = delivered.length;
        expect(
            await status(
                post("/api/account/email", {
                    email: "verification-" + username + "@example.test",
                })
            )
        ).toBe(200);
        await application.maintain();
        expect(delivered.slice(before)).toHaveLength(1);
        expect(delivered.at(-1)?.subject).toBe("Verify your Homelab email");
    });

    test.each(["ip", "user"])(
        "rejected reset %s limits cannot consume global admission",
        async (kind) => {
            const database = application.connection.database;
            await database.delete(mailOutbox);
            await database.insert(rateBuckets).values({
                digest: tokenDigest(
                    kind === "ip" ? "reset-ip:blocked" : "reset-user:blocked"
                ),
                attempts: kind === "ip" ? 10 : 3,
                expiresAt: new Date(Date.now() + 3_600_000),
            });
            for (let index = 0; index < 4; index += 1) {
                const result = await application.services.email
                    .requestReset(
                        kind === "user" ? "blocked" : "rejected-" + index,
                        kind === "ip" ? "blocked" : "rejected-" + index
                    )
                    .then(
                        () => null,
                        (error: unknown) => error
                    );
                expect(result).toMatchObject({ status: 429 });
            }
            expect(await database.select().from(mailOutbox)).toHaveLength(0);
            expect(
                await database
                    .select()
                    .from(rateBuckets)
                    .where(eq(rateBuckets.digest, tokenDigest("reset-global")))
            ).toHaveLength(0);
            for (let index = 0; index < 4; index += 1)
                await application.services.email.requestReset(
                    "allowed-" + index,
                    "allowed-" + index
                );
            expect(await database.select().from(mailOutbox)).toHaveLength(4);
        }
    );

    test("session advertises recovery only while unused codes remain", async () => {
        const enrollment = await enrollTotp();
        expect(
            v.parse(
                v.object({ recoveryAvailable: v.boolean() }),
                await responseJson(browser("/api/session"))
            ).recoveryAvailable
        ).toBe(true);
        const digest = tokenDigest(cookieJar.get("homelab_auth")?.value ?? "");
        const principal = await application.services.accounts.principalByToken(
            cookieJar.get("homelab_auth")?.value ?? ""
        );
        await application.connection.database
            .delete(recoveryCodes)
            .where(eq(recoveryCodes.userId, principal.user.id));
        expect(enrollment.codes).toHaveLength(10);
        expect(
            v.parse(
                v.object({ recoveryAvailable: v.boolean() }),
                await responseJson(browser("/api/session"))
            ).recoveryAvailable
        ).toBe(false);
        const [session] = await application.connection.database
            .select()
            .from(sessions)
            .where(eq(sessions.tokenHash, digest));
        expect(session).toBeDefined();
    });

    test("reset requests enqueue identical work before any account lookup or delivery", async () => {
        await application.connection.database.delete(mailOutbox);
        await application.connection.database.delete(challenges);
        const unverified = "unverified-" + crypto.randomUUID();
        await application.connection.database.insert(users).values({
            id: crypto.randomUUID(),
            username: unverified,
            email: unverified + "@example.test",
            emailVerified: false,
            passwordHash: await hashPassword(password),
            groups: [],
            createdAt: new Date(),
        });
        const before = delivered.length;
        for (const candidate of [username, unverified, "missing-" + crypto.randomUUID()])
            expect(
                await status(post("/api/password/request-reset", { username: candidate }))
            ).toBe(200);
        const queued = await application.connection.database.select().from(mailOutbox);
        expect(queued).toHaveLength(3);
        expect(
            queued.every((item) => item.proofDigest === null && item.sentAt === null)
        ).toBe(true);
        expect(
            await application.connection.database.select().from(challenges)
        ).toHaveLength(0);
        expect(delivered).toHaveLength(before);
        await application.maintain();
        expect(delivered.slice(before)).toHaveLength(1);
        expect(delivered.at(-1)?.to).toBe(username + "@example.test");
    });

    test("superseded queued reset emails cannot be retried after their replacement", async () => {
        await application.connection.database.delete(mailOutbox);
        expect(await status(post("/api/password/request-reset", { username }))).toBe(200);
        await application.maintain();
        const [old] = await application.connection.database.select().from(mailOutbox);
        if (!old?.proofDigest) throw new Error("Proof message missing");
        // Model an old delivery awaiting retry, without contacting an email provider.
        await application.connection.database
            .update(mailOutbox)
            .set({ sentAt: null, nextAttemptAt: new Date(Date.now() + 60_000) })
            .where(eq(mailOutbox.id, old.id));
        const before = delivered.length;
        expect(await status(post("/api/password/request-reset", { username }))).toBe(200);
        await application.maintain();
        expect(
            await application.connection.database
                .select()
                .from(mailOutbox)
                .where(eq(mailOutbox.id, old.id))
        ).toHaveLength(0);
        expect(
            await application.connection.database
                .select()
                .from(challenges)
                .where(eq(challenges.digest, old.proofDigest))
        ).toHaveLength(0);
        expect(delivered.slice(before)).toHaveLength(1);
    });

    test("revoking the initiating session invalidates its pending email replacement", async () => {
        const current = await json(
            browser("/api/account"),
            v.object({
                user: v.object({ email: v.string() }),
                sessions: v.array(v.object({ id: v.string(), current: v.boolean() })),
            })
        );
        const initiating = current.sessions.find((session) => session.current);
        if (!initiating) throw new Error("Initiating session missing");
        const replacement = `replacement-${username}@example.test`;
        expect(await status(post("/api/account/email", { email: replacement }))).toBe(
            200
        );
        const token = await emailProof(replacement, "Verify");
        expect(await status(post("/api/login", { username, password }))).toBe(200);
        expect(
            await status(post("/api/account/session/revoke", { id: initiating.id }))
        ).toBe(200);
        expect(await status(post("/api/email/verify", { token }))).toBe(400);
        const account = await json(
            browser("/api/account"),
            v.object({
                user: v.object({ email: v.string() }),
            })
        );
        expect(account.user.email).toBe(current.user.email);
    });

    test("expired initiating sessions cannot redeem an email replacement", async () => {
        const replacement = `expired-${username}@example.test`;
        expect(await status(post("/api/account/email", { email: replacement }))).toBe(
            200
        );
        const token = await emailProof(replacement, "Verify");
        const sessionToken = cookieJar.get("homelab_auth")?.value ?? "";
        await application.connection.database
            .update(sessions)
            .set({ expiresAt: new Date(Date.now() - 1000) })
            .where(eq(sessions.tokenHash, tokenDigest(sessionToken)));
        expect(await status(post("/api/email/verify", { token }))).toBe(401);
        const [account] = await application.connection.database
            .select()
            .from(users)
            .where(eq(users.username, username));
        expect(account?.email).toBe(`${username}@example.test`);
    });

    test("replacing email invalidates old reset links but permits recovery at the new address", async () => {
        expect(await status(post("/api/password/request-reset", { username }))).toBe(200);
        const oldReset = await emailProof(`${username}@example.test`, "Reset");
        const replacement = `new-${username}@example.test`;
        expect(await status(post("/api/account/email", { email: replacement }))).toBe(
            200
        );
        const verification = await emailProof(replacement, "Verify");
        expect(await status(post("/api/email/verify", { token: verification }))).toBe(
            200
        );
        const newPassword = password + "-recovered";
        expect(
            await status(
                post("/api/password/reset", {
                    token: oldReset,
                    password: newPassword,
                })
            )
        ).toBe(400);
        const [account] = await application.connection.database
            .select()
            .from(users)
            .where(eq(users.username, username));
        if (!account) throw new Error("Test account missing");
        expect(
            await application.services.accounts.checkPassword(
                password,
                account.passwordHash
            )
        ).toBe(true);
        expect(account.email).toBe(replacement);
        expect(await status(post("/api/password/request-reset", { username }))).toBe(200);
        const newReset = await emailProof(replacement, "Reset");
        expect(
            await status(
                post("/api/password/reset", {
                    token: newReset,
                    password: newPassword,
                })
            )
        ).toBe(200);
        expect(
            await status(post("/api/login", { username, password: newPassword }))
        ).toBe(200);
    });

    test("changes passwords without leaving old sessions or pending proofs usable", async () => {
        const oldCookie = cookieJar.get("homelab_auth")?.value;
        expect(await status(post("/api/login", { username, password }))).toBe(200);
        expect(await status(post("/api/password/request-reset", { username }))).toBe(200);
        const snapshot = await json(
            browser("/api/account"),
            v.object({ user: v.object({ id: v.string() }) })
        );
        await application.maintain();
        const pending = await application.connection.database
            .select()
            .from(challenges)
            .where(eq(challenges.userId, snapshot.user.id));
        expect(pending.length).toBeGreaterThan(0);
        const changed = password + "-changed";
        expect(
            await status(
                post("/api/account/password", {
                    currentPassword: password,
                    newPassword: changed,
                })
            )
        ).toBe(200);
        expect(
            await status(
                browser("/api/account", {
                    headers: { cookie: "homelab_auth=" + (oldCookie ?? "") },
                })
            )
        ).toBe(401);
        const remaining = await application.connection.database
            .select()
            .from(challenges)
            .where(eq(challenges.userId, snapshot.user.id));
        expect(remaining).toHaveLength(0);
        expect(await status(post("/api/login", { username, password }))).toBe(401);
        expect(await status(post("/api/login", { username, password: changed }))).toBe(
            200
        );
        const inventory = await json(
            browser("/api/account"),
            v.object({
                sessions: v.array(v.object({ id: v.string(), current: v.boolean() })),
            })
        );
        const other = inventory.sessions.find((entry) => !entry.current);
        if (!other) throw new Error("Other test session missing");
        expect(await status(post("/api/account/session/revoke", { id: other.id }))).toBe(
            200
        );
        expect(await status(post("/api/account/sessions/revoke-others", {}))).toBe(200);
    });

    test.each([false, true])(
        "self-revocation needs no fresh proof with enrolled MFA=%s, while other sessions remain protected",
        async (withMfa) => {
            if (withMfa) await enrollTotp();
            const token = cookieJar.get("homelab_auth")?.value;
            if (!token) throw new Error("Current cookie missing");
            const principal = await application.services.accounts.principalByToken(token);
            const otherId = crypto.randomUUID();
            const now = new Date();
            await application.connection.database.insert(sessions).values({
                id: otherId,
                userId: principal.user.id,
                tokenHash: tokenDigest(otherId),
                userAgent: "Other synthetic browser",
                createdAt: now,
                passwordAt: now,
                lastSeenAt: now,
                expiresAt: new Date(now.getTime() + 60_000),
            });
            await application.connection.database
                .update(sessions)
                .set({
                    passwordAt: new Date(now.getTime() - 10 * 60_000),
                    ...(withMfa ? { mfaAt: new Date(now.getTime() - 10 * 60_000) } : {}),
                })
                .where(eq(sessions.id, principal.session.id));
            expect(
                await status(post("/api/account/session/revoke", { id: otherId }))
            ).toBe(403);
            expect(
                await status(
                    post("/api/account/session/revoke", { id: principal.session.id })
                )
            ).toBe(200);
            expect(await status(browser("/api/account"))).toBe(401);
            expect(
                await application.connection.database
                    .select()
                    .from(sessions)
                    .where(eq(sessions.id, otherId))
            ).toHaveLength(1);
            expect(
                await application.connection.database
                    .select()
                    .from(sessions)
                    .where(eq(sessions.id, principal.session.id))
            ).toHaveLength(0);
        }
    );

    test("rotates recovery codes, removes a factor and revokes all sessions through Settings", async () => {
        const original = await enrollTotp();
        const rotated = await json(
            post("/api/account/recovery/rotate", {}),
            v.object({ recoveryCodes: v.array(v.string()) })
        );
        expect(rotated.recoveryCodes).toHaveLength(10);
        expect(rotated.recoveryCodes).not.toEqual(original.codes);
        expect(
            await status(post("/api/account/proof/recovery", { code: original.codes[0] }))
        ).toBe(400);
        const snapshot = await json(
            browser("/api/account"),
            v.object({ factors: v.array(v.object({ id: v.string() })) })
        );
        const factor = snapshot.factors[0];
        if (!factor) throw new Error("Test factor missing");
        expect(await status(post("/api/account/factor/remove", { id: factor.id }))).toBe(
            200
        );
        const after = await json(
            browser("/api/account"),
            v.object({
                factors: v.array(v.unknown()),
                recoveryCodesRemaining: v.number(),
            })
        );
        expect(after.factors).toHaveLength(0);
        expect(after.recoveryCodesRemaining).toBe(0);
        expect(await status(post("/api/account/sessions/revoke-all", {}))).toBe(200);
        expect(await status(browser("/api/account"))).toBe(401);
    });

    test("rate limits repeated invalid security proofs", async () => {
        for (let attempt = 0; attempt < 10; attempt += 1)
            expect(
                await status(
                    post("/api/account/proof/password", {
                        password: "not-the-real-password",
                    })
                )
            ).toBe(400);
        expect(await status(post("/api/account/proof/password", { password }))).toBe(429);
    });

    test("supports a separate basic-authenticated client without granting account administration", async () => {
        await enrollTotp();
        const tokens = await authorizationTokens(
            "openid profile email groups",
            "basic-client"
        );
        expect(
            await status(
                browser("/userinfo", {
                    headers: { authorization: `Bearer ${tokens.access_token}` },
                })
            )
        ).toBe(200);
        expect(
            await status(
                browser("/api/account", {
                    headers: { authorization: `Bearer ${tokens.access_token}` },
                })
            )
        ).toBe(401);
        const jwks = await responseJson(browser("/jwks"));
        expect(JSON.stringify(jwks)).not.toContain('"d":');
        expect(JSON.stringify(jwks)).not.toContain('"p":');
    });

    test("removing the last factor revokes current-session OIDC grants permanently", async () => {
        await enrollTotp();
        await enrollTotp();
        const external = await authorizationTokens(
            "openid profile email groups offline_access",
            "basic-client"
        );
        const dashboardTokens = await authorizationTokens(
            "openid profile email groups account offline_access"
        );
        expect(external.refresh_token).toBeTruthy();
        expect(dashboardTokens.refresh_token).toBeTruthy();
        const inventory = await json(
            browser("/api/account"),
            v.object({ factors: v.array(v.object({ id: v.string() })) })
        );
        expect(inventory.factors).toHaveLength(2);
        const [first, last] = inventory.factors;
        if (!first || !last) throw new Error("Test factors missing");
        const userinfo = (token: string) =>
            browser("/userinfo", {
                headers: { authorization: "Bearer " + token },
            });
        expect(await status(post("/api/account/factor/remove", { id: first.id }))).toBe(
            200
        );
        expect(await status(userinfo(external.access_token))).toBe(200);
        expect(await status(userinfo(dashboardTokens.access_token))).toBe(200);
        expect(await status(post("/api/account/factor/remove", { id: last.id }))).toBe(
            200
        );
        expect(await status(userinfo(external.access_token))).toBe(401);
        expect(await status(userinfo(dashboardTokens.access_token))).toBe(401);
        expect(
            await status(
                formPost(
                    "/token",
                    {
                        grant_type: "refresh_token",
                        refresh_token: external.refresh_token ?? "",
                    },
                    "Basic " +
                        Buffer.from("basic-client:" + clientSecret).toString("base64")
                )
            )
        ).toBe(400);
        expect(
            await status(
                formPost("/token", {
                    grant_type: "refresh_token",
                    refresh_token: dashboardTokens.refresh_token ?? "",
                    client_id: "dashboard",
                    client_secret: clientSecret,
                })
            )
        ).toBe(400);
        // Keep the central cookie so the account can enroll MFA again.
        expect(await status(browser("/api/account"))).toBe(200);
        await enrollTotp();
        expect(await status(userinfo(external.access_token))).toBe(401);
        expect(await status(userinfo(dashboardTokens.access_token))).toBe(401);
        const fresh = await authorizationTokens("openid profile", "basic-client");
        expect(await status(userinfo(fresh.access_token))).toBe(200);
    });

    test("rotates refresh tokens and revokes them with the central session", async () => {
        const result = await authorizationTokens(
            "openid profile email groups account offline_access"
        );
        expect(result.refresh_token).toBeTruthy();
        const refreshed = await formPost("/token", {
            grant_type: "refresh_token",
            refresh_token: result.refresh_token ?? "",
            client_id: "dashboard",
            client_secret: clientSecret,
        });
        expect(refreshed.status).toBe(200);
        const tokens = v.parse(tokenResponseSchema, await refreshed.json());
        expect(tokens.refresh_token).toBeTruthy();
        expect(tokens.refresh_token).not.toBe(result.refresh_token);
        expect(await status(post("/api/logout", {}))).toBe(200);
        expect(
            await status(
                formPost("/token", {
                    grant_type: "refresh_token",
                    refresh_token: tokens.refresh_token ?? "",
                    client_id: "dashboard",
                    client_secret: clientSecret,
                })
            )
        ).toBe(400);
        expect(
            await status(
                browser("/userinfo", {
                    headers: { authorization: `Bearer ${tokens.access_token}` },
                })
            )
        ).toBe(401);
    });

    test("RP logout requires confirmation and revokes the central session", async () => {
        const tokens = await authorizationTokens("openid profile");
        const query = new URLSearchParams({
            id_token_hint: tokens.id_token,
            post_logout_redirect_uri: issuer + "/signed-out",
        });
        const prompt = await browser("/session/end?" + query.toString());
        expect(prompt.status).toBe(200);
        const html = await prompt.text();
        const xsrf = /name="xsrf" value="([^"]+)"/.exec(html)?.[1];
        const action = /method="post" action="([^"]+)"/.exec(html)?.[1];
        if (!xsrf || !action) throw new Error("Missing logout confirmation");
        expect(await status(browser("/api/account"))).toBe(200);
        const forged = await formPost(action, { xsrf: "invalid", logout: "yes" });
        expect(forged.status).toBe(400);
        expect(await status(browser("/api/account"))).toBe(200);
        const signedOut = await formPost(action, { xsrf, logout: "yes" });
        expect(signedOut.status).toBe(303);
        expect(logoutTokens.length).toBeGreaterThan(0);
        expect(signedOut.headers.get("location")).toBe(issuer + "/signed-out");
        expect(await status(browser("/api/account"))).toBe(401);
        expect(
            await status(
                browser("/userinfo", {
                    headers: { authorization: `Bearer ${tokens.access_token}` },
                })
            )
        ).toBe(401);
    });

    test("rejects authorization without S256 and unregistered redirect destinations", async () => {
        const base = {
            client_id: "dashboard",
            response_type: "code",
            scope: "openid",
            redirect_uri: issuer + "/callback",
            state: "test",
        };
        const noPkce = await browser(
            "/authorize?" + new URLSearchParams(base).toString()
        );
        const location = noPkce.headers.get("location");
        expect(noPkce.status === 400 || Boolean(location?.includes("error="))).toBe(true);
        const unregistered = await browser(
            "/authorize?" +
                new URLSearchParams({
                    ...base,
                    redirect_uri: "https://attacker.example.test/callback",
                }).toString()
        );
        expect(unregistered.status).toBe(400);
        expect(unregistered.headers.get("location")).toBeNull();
    });

    test("consumes recovery codes atomically under simultaneous requests", async () => {
        const enrollment = await enrollTotp();
        const code = enrollment.codes[0];
        const outcomes = await Promise.all([
            status(post("/api/account/proof/recovery", { code })),
            status(post("/api/account/proof/recovery", { code })),
        ]);
        expect(outcomes.toSorted((left, right) => left - right)).toEqual([200, 400]);
        const snapshot = await json(
            browser("/api/account"),
            v.object({ recoveryCodesRemaining: v.number() })
        );
        expect(snapshot.recoveryCodesRemaining).toBe(9);
    });

    test("verifies real WebAuthn signatures, rejects wrong origin and missing user verification, and preserves NFC", async () => {
        const authenticator = softwareAuthenticator();
        const setup = await json(
            post("/api/account/webauthn/begin", {}),
            webauthnOptionsSchema
        );
        const registration = authenticator.registration(setup.options.challenge, issuer);
        expect(
            await status(
                post("/api/account/webauthn/finish", {
                    token: setup.token,
                    label: "Test NFC key",
                    response: registration,
                })
            )
        ).toBe(200);
        expect(
            await status(
                post("/api/account/webauthn/finish", {
                    token: setup.token,
                    label: "Replay",
                    response: registration,
                })
            )
        ).toBe(400);
        const proof = await json(
            post("/api/account/proof/webauthn/begin", {}),
            webauthnOptionsSchema
        );
        expect(proof.options.allowCredentials?.[0]?.transports).toContain("nfc");
        expect(
            await status(
                post("/api/account/proof/webauthn/finish", {
                    token: proof.token,
                    response: authenticator.assertion(
                        proof.options.challenge,
                        "https://attacker.example"
                    ),
                })
            )
        ).toBe(400);
        expect(
            await status(
                post("/api/account/proof/webauthn/finish", {
                    token: proof.token,
                    response: authenticator.assertion(
                        proof.options.challenge,
                        issuer,
                        2,
                        false
                    ),
                })
            )
        ).toBe(400);
        const valid = authenticator.assertion(proof.options.challenge, issuer);
        expect(
            await status(
                post("/api/account/proof/webauthn/finish", {
                    token: proof.token,
                    response: valid,
                })
            )
        ).toBe(200);
        expect(
            await status(
                post("/api/account/proof/webauthn/finish", {
                    token: proof.token,
                    response: valid,
                })
            )
        ).toBe(400);
    });

    test("pre-authenticated sessions cannot read settings until MFA is completed", async () => {
        const enrollment = await enrollTotp();
        expect(await status(post("/api/login", { username, password }))).toBe(200);
        expect(await status(browser("/api/account"))).toBe(403);
        const token = cookieJar.get("homelab_auth")?.value ?? "";
        const lastSeen = new Date(Date.now() - 300_000);
        await application.connection.database
            .update(sessions)
            .set({ lastSeenAt: lastSeen })
            .where(eq(sessions.tokenHash, tokenDigest(token)));
        expect(
            await status(
                browser("/api/session", {
                    headers: { "X-Homelab-Session-Activity": "1" },
                })
            )
        ).toBe(200);
        const [unchanged] = await application.connection.database
            .select()
            .from(sessions)
            .where(eq(sessions.tokenHash, tokenDigest(token)));
        expect(unchanged?.lastSeenAt.getTime()).toBe(lastSeen.getTime());
        expect(await status(post("/api/account/proof/password", { password }))).toBe(200);
        expect(await status(browser("/api/account"))).toBe(403);
        expect(
            await status(
                post("/api/account/proof/recovery", { code: enrollment.codes[0] })
            )
        ).toBe(200);
        expect(await status(browser("/api/account"))).toBe(200);
    });

    test("session and factor IDs never authorize access to another account", async () => {
        const [otherUser] = await application.connection.database
            .select({ id: users.id })
            .from(users)
            .where(eq(users.username, "testoperator"));
        const [other] = await application.connection.database
            .select({ id: sessions.id })
            .from(sessions)
            .where(eq(sessions.userId, otherUser?.id ?? crypto.randomUUID()));
        const missing = other?.id ?? crypto.randomUUID();
        expect(await status(post("/api/account/session/revoke", { id: missing }))).toBe(
            404
        );
        expect(await status(post("/api/account/factor/remove", { id: missing }))).toBe(
            404
        );
    });

    test.each(["dashboard", "basic-client"])(
        "%s requires explicit consent with the displayed interaction and account",
        async (clientId) => {
            if (clientId !== "dashboard") await enrollTotp();
            const consent = await pendingConsent(clientId);
            expect(consent.clientId).toBe(clientId);
            expect(consent.username).toBe(username);
            expect(consent.redirectOrigin).toBe(issuer);
            expect(consent.scopes).toEqual(["openid", "profile", "email"]);
            const before = await application.connection.database
                .select()
                .from(grantSessions);
            expect(
                await json(post("/sign-in/complete", {}), oidcInteractionSchema)
            ).toEqual({ consent });
            for (const invalid of [
                { interactionId: "another-interaction", accountId: consent.accountId },
                { interactionId: consent.interactionId, accountId: crypto.randomUUID() },
                {
                    interactionId: consent.interactionId,
                    accountId: consent.accountId,
                    scopes: ["account"],
                },
            ]) {
                expect(
                    await status(
                        post("/sign-in/complete", { ...invalid, decision: "approve" })
                    )
                ).toBe(403);
            }
            expect(
                await status(
                    browser("/sign-in/complete", {
                        method: "POST",
                        headers: {
                            "content-type": "application/json",
                            origin: "https://attacker.example",
                        },
                        body: JSON.stringify({
                            interactionId: consent.interactionId,
                            accountId: consent.accountId,
                            decision: "approve",
                        }),
                    })
                )
            ).toBe(403);
            expect(
                await application.connection.database.select().from(grantSessions)
            ).toEqual(before);
            const result = await json(
                post("/sign-in/complete", {
                    interactionId: consent.interactionId,
                    accountId: consent.accountId,
                    decision: "approve",
                }),
                v.object({ redirect: v.string() })
            );
            const granted = await application.connection.database
                .select()
                .from(grantSessions);
            const retry = await json(
                post("/sign-in/complete", {
                    interactionId: consent.interactionId,
                    accountId: consent.accountId,
                    decision: "approve",
                }),
                v.object({ redirect: v.string() })
            );
            expect(retry).toEqual(result);
            expect(
                await application.connection.database.select().from(grantSessions)
            ).toEqual(granted);
            const resumed = await browser(result.redirect);
            const callback = new URL(resumed.headers.get("location") ?? "", issuer);
            expect(callback.pathname).toBe("/callback");
            expect(callback.searchParams.has("code")).toBe(true);
            expect(callback.searchParams.get("state")).toBe("consent-state");
            expect(
                await status(
                    post("/sign-in/complete", {
                        interactionId: consent.interactionId,
                        accountId: consent.accountId,
                        decision: "approve",
                    })
                )
            ).toBe(410);
        }
    );

    test("denied app consent returns access_denied without a grant or signing out the user", async () => {
        const consent = await pendingConsent("dashboard");
        const before = await application.connection.database.select().from(grantSessions);
        const next = await json(
            post("/sign-in/complete", {
                interactionId: consent.interactionId,
                accountId: consent.accountId,
                decision: "deny",
            }),
            v.object({ redirect: v.string() })
        );
        const resumed = await browser(next.redirect);
        const callback = new URL(resumed.headers.get("location") ?? "", issuer);
        expect(callback.pathname).toBe("/callback");
        expect(callback.searchParams.get("error")).toBe("access_denied");
        expect(callback.searchParams.get("state")).toBe("consent-state");
        expect(callback.searchParams.has("code")).toBe(false);
        expect(
            await application.connection.database.select().from(grantSessions)
        ).toEqual(before);
        expect(await status(browser("/api/account"))).toBe(200);
        const retry = await pendingConsent("dashboard");
        expect(retry.interactionId).not.toBe(consent.interactionId);
        const approved = await approveTestInteraction();
        const accepted = await browser(approved.redirect);
        const returned = new URL(accepted.headers.get("location") ?? "", issuer);
        expect(returned.searchParams.has("code")).toBe(true);
        expect(returned.searchParams.has("error")).toBe(false);
    });

    test("a signed-in browser with an expired interaction gets a structured restart response", async () => {
        const response = await post("/sign-in/complete", {});
        expect(response.status).toBe(410);
        expect(await response.json()).toEqual({
            code: "INTERACTION_EXPIRED",
            message: "This sign-in request has expired. Start a new sign-in to continue.",
        });
        expect(response.headers.get("cache-control")).toBe("no-store");
    });

    test.each(["settings", "direct", "oidc"] as const)(
        "%s logout takes the account lock before any session lock",
        async (route) => {
            const tokens = await authorizationTokens("openid profile");
            const accounts = application.services.accounts;
            const principal = await accounts.principalByToken(
                cookieJar.get("homelab_auth")?.value ?? ""
            );
            let logoutAction = "";
            let xsrf = "";
            if (route === "oidc") {
                const prompt = await browser(
                    "/session/end?" +
                        new URLSearchParams({
                            id_token_hint: tokens.id_token,
                            post_logout_redirect_uri: issuer + "/signed-out",
                        }).toString()
                );
                const html = await prompt.text();
                logoutAction = /method="post" action="([^"]+)"/.exec(html)?.[1] ?? "";
                xsrf = /name="xsrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
                expect(logoutAction).not.toBe("");
                expect(xsrf).not.toBe("");
            }
            let signingOut: Promise<number> | undefined;
            try {
                await accounts.database.transaction(async (transaction) => {
                    await transaction
                        .select({ id: users.id })
                        .from(users)
                        .where(eq(users.id, principal.user.id))
                        .for("update");
                    const [{ pid }] = v.parse(
                        v.tuple([v.object({ pid: v.number() })]),
                        await transaction.execute(sql`select pg_backend_pid() as pid`)
                    );
                    signingOut = status(
                        route === "oidc"
                            ? formPost(logoutAction, { xsrf, logout: "yes" })
                            : post(
                                  route === "settings"
                                      ? "/api/account/session/revoke"
                                      : "/api/logout",
                                  route === "settings" ? { id: principal.session.id } : {}
                              )
                    );
                    // Observe the actual blocked request, rather than assume a scheduling delay.
                    let waiting = false;
                    for (let attempt = 0; attempt < 100; attempt += 1) {
                        const [state] = v.parse(
                            v.tuple([v.object({ waiting: v.boolean() })]),
                            await transaction.execute(sql`
                                select exists (
                                    select 1 from pg_stat_activity
                                    where ${pid} = any(pg_blocking_pids(pid))
                                ) as waiting
                            `)
                        );
                        waiting = state.waiting;
                        if (waiting) break;
                        await Bun.sleep(10);
                    }
                    expect(waiting).toBe(true);
                    // Expiry cleanup owns this account first. Logout must not hold the session
                    // while waiting for it, including when its audit insert needs the user FK.
                    expect(
                        await transaction
                            .select({ id: sessions.id })
                            .from(sessions)
                            .where(eq(sessions.id, principal.session.id))
                            .for("update", { noWait: true })
                    ).toHaveLength(1);
                });
            } finally {
                if (signingOut)
                    expect(await signingOut).toBe(route === "oidc" ? 303 : 200);
            }
            expect(await status(browser("/api/account"))).toBe(401);
            await accounts.revokeExpired(principal.session.id, new Date());
        }
    );

    test("maintenance retains a candidate refreshed after the expiry batch was selected", async () => {
        const accounts = application.services.accounts;
        const principal = await accounts.principalByToken(
            cookieJar.get("homelab_auth")?.value ?? ""
        );
        const cutoff = new Date();
        const old = new Date(cutoff.getTime() - 3_700_000);
        await accounts.database
            .update(sessions)
            .set({ lastSeenAt: old })
            .where(eq(sessions.id, principal.session.id));
        await accounts.touch({
            ...principal,
            session: { ...principal.session, lastSeenAt: old },
        });
        await accounts.revokeExpired(principal.session.id, cutoff);
        expect(await status(browser("/api/account"))).toBe(200);
    });

    test("expiry cleanup cannot revoke a protected mutation that renews its session", async () => {
        const accounts = application.services.accounts;
        const principal = await accounts.principalByToken(
            cookieJar.get("homelab_auth")?.value ?? ""
        );
        const entered = Promise.withResolvers<void>();
        const finish = Promise.withResolvers<void>();
        const action = accounts.protectedAction(
            principal,
            async (transaction, current) => {
                entered.resolve();
                await finish.promise;
                await transaction.insert(auditEvents).values({
                    id: crypto.randomUUID(),
                    userId: current.user.id,
                    event: "test_protected_activity",
                    createdAt: new Date(),
                });
            }
        );
        await entered.promise;
        let cleanup: Promise<void> | undefined;
        try {
            await accounts.database
                .update(sessions)
                .set({ lastSeenAt: new Date(Date.now() - 3_700_000) })
                .where(eq(sessions.id, principal.session.id));
            cleanup = accounts.revokeExpired(principal.session.id, new Date());
        } finally {
            finish.resolve();
            await action;
            await cleanup;
        }
        expect(await status(browser("/api/account"))).toBe(200);
        expect(
            await accounts.database
                .select()
                .from(auditEvents)
                .where(eq(auditEvents.event, "test_protected_activity"))
        ).toHaveLength(1);
    });

    test("maintenance revokes still-expired sessions before stale protected actions can run", async () => {
        const accounts = application.services.accounts;
        const principal = await accounts.principalByToken(
            cookieJar.get("homelab_auth")?.value ?? ""
        );
        await accounts.database
            .update(sessions)
            .set({ expiresAt: new Date(Date.now() - 1) })
            .where(eq(sessions.id, principal.session.id));
        await application.maintain();
        let ran = false;
        function markAttempt(): Promise<void> {
            ran = true;
            return Promise.resolve();
        }
        const failure = await accounts.protectedAction(principal, markAttempt).then(
            () => null,
            (error: unknown) => error
        );
        expect(failure).toMatchObject({ status: 401 });
        expect(ran).toBe(false);
        expect(await status(browser("/api/account"))).toBe(401);
        await accounts.revokeExpired(principal.session.id, new Date());
    });

    test("idle expiration is enforced server-side even while a cookie remains", async () => {
        const token = cookieJar.get("homelab_auth")?.value ?? "";
        await application.connection.database
            .update(sessions)
            .set({ lastSeenAt: new Date(Date.now() - 3_700_000) })
            .where(eq(sessions.tokenHash, tokenDigest(token)));
        expect(await status(browser("/api/account"))).toBe(401);
    });

    test("password recovery consumes one proof, revokes sessions and retains MFA", async () => {
        await enrollTotp();
        expect(await status(post("/api/password/request-reset", { username }))).toBe(200);
        await application.services.email.deliverPending();
        const message = delivered.findLast(
            (entry) =>
                entry.to === `${username}@example.test` && entry.subject.includes("Reset")
        );
        const token = message?.text.match(/#token=([\w-]{43})/)?.[1];
        if (!token) throw new Error("Reset proof missing");
        const replacement = "new-isolated-test-password";
        expect(
            await status(post("/api/password/reset", { token, password: replacement }))
        ).toBe(200);
        expect(
            await status(post("/api/password/reset", { token, password: replacement }))
        ).toBe(400);
        expect(await status(browser("/api/account"))).toBe(401);
        expect(await status(post("/api/login", { username, password }))).toBe(401);
        const result = await json(
            post("/api/login", { username, password: replacement }),
            v.object({ mfaRequired: v.boolean() })
        );
        expect(result.mfaRequired).toBe(true);
    });

    test("ForwardAuth authorizes passive requests without renewing their idle lifetime", async () => {
        await enrollTotp();
        const accounts = application.services.accounts;
        const principal = await accounts.principalByToken(
            cookieJar.get("homelab_auth")?.value ?? ""
        );
        const cookie =
            "__Host-homelab_sso=" +
            encryptValue(
                accounts.configuration.encryptionKey,
                "resource:https://tools.example.test",
                {
                    sessionId: principal.session.id,
                    expiresAt: principal.session.expiresAt.getTime(),
                }
            );
        const original = new Date(Date.now() - 600_000);
        const cases: { headers: Record<string, string>; active: boolean }[] = [
            { headers: {}, active: false },
            {
                headers: {
                    Origin: "https://sibling.example.test",
                    "Sec-Fetch-Site": "same-site",
                },
                active: false,
            },
            {
                headers: {
                    Origin: "https://tools.example.test",
                    "Sec-Fetch-Site": "same-site",
                },
                active: false,
            },
            {
                headers: {
                    Origin: "https://sibling.example.test",
                    "Sec-Fetch-Site": "same-origin",
                },
                active: false,
            },
            { headers: { "Sec-Fetch-Site": "same-origin" }, active: true },
            { headers: { Origin: "https://tools.example.test" }, active: true },
        ];
        for (const item of cases) {
            await accounts.database
                .update(sessions)
                .set({ lastSeenAt: original })
                .where(eq(sessions.id, principal.session.id));
            expect(
                await status(proxyRequest("/settings", cookie, true, item.headers))
            ).toBe(200);
            const current = await accounts.principalById(principal.session.id);
            expect(current.session.lastSeenAt.getTime() > original.getTime()).toBe(
                item.active
            );
        }
    });

    test("password-only sessions cannot evict verified sessions; completed MFA enforces its own cap", async () => {
        const enrollment = await enrollTotp();
        const accounts = application.services.accounts;
        const original = await accounts.principalByToken(
            cookieJar.get("homelab_auth")?.value ?? ""
        );
        await accounts.database
            .update(sessions)
            .set({ lastSeenAt: new Date(Date.now() - 600_000) })
            .where(eq(sessions.id, original.session.id));
        await accounts.database.insert(sessions).values(
            Array.from({ length: 31 }, (_, index) => ({
                ...original.session,
                id: crypto.randomUUID(),
                tokenHash: tokenDigest(crypto.randomUUID()),
                createdAt: new Date(Date.now() - 60_000 + index),
                lastSeenAt: new Date(Date.now() - 60_000 + index),
                mfaAt: index < 16 ? null : new Date(),
            }))
        );
        expect(await status(post("/api/login", { username, password }))).toBe(200);
        const retained = await accounts.principalById(original.session.id);
        expect(retained.session.mfaAt).not.toBeNull();
        let inventory = await accounts.database
            .select()
            .from(sessions)
            .where(eq(sessions.userId, original.user.id));
        expect(inventory.filter((item) => item.mfaAt === null)).toHaveLength(16);
        expect(inventory.filter((item) => item.mfaAt !== null)).toHaveLength(16);
        expect(
            await status(
                post("/api/account/proof/recovery", { code: enrollment.codes[0] })
            )
        ).toBe(200);
        inventory = await accounts.database
            .select()
            .from(sessions)
            .where(eq(sessions.userId, original.user.id));
        expect(inventory.filter((item) => item.mfaAt === null)).toHaveLength(15);
        expect(inventory.filter((item) => item.mfaAt !== null)).toHaveLength(16);
        expect(inventory.some((item) => item.id === original.session.id)).toBe(false);
    });

    test("ForwardAuth accepts canonical host equivalents but rejects authority injection", async () => {
        for (const host of [
            "tools.example.test",
            "TOOLS.example.test",
            "tools.example.test:443",
            "TOOLS.example.test:443",
        ]) {
            const result = await browser("/api/authz/forward-auth", {
                headers: {
                    "x-homelab-proxy-key":
                        application.services.accounts.configuration.proxyKey,
                    "x-forwarded-proto": "https",
                    "x-forwarded-host": host,
                    "x-forwarded-uri": "/manifest.webmanifest",
                },
            });
            expect(result.status).toBe(200);
        }
        for (const host of [
            "tools.example.test:444",
            "tools.example.test@evil.test",
            "tools.example.test/path",
            "tools.example.test?query=1",
            "tools.example.test#fragment",
            "evil.test",
        ]) {
            const result = await browser("/api/authz/forward-auth", {
                headers: {
                    "x-homelab-proxy-key":
                        application.services.accounts.configuration.proxyKey,
                    "x-forwarded-proto": "https",
                    "x-forwarded-host": host,
                    "x-forwarded-uri": "/manifest.webmanifest",
                },
            });
            expect(result.status).toBe(403);
        }
    });

    test("ForwardAuth rejects untrusted proxies and limits public exceptions", async () => {
        expect(await status(proxyRequest("/public/catalog.json", undefined, false))).toBe(
            403
        );
        expect(await status(proxyRequest("/manifest.webmanifest"))).toBe(200);
        expect(await status(proxyRequest("/public/catalog.json"))).toBe(200);
        expect(await status(proxyRequest("/publicity/settings"))).toBe(302);
        expect(await status(proxyRequest("/public/%2fadmin"))).toBe(403);
    });

    test("ForwardAuth tickets bind the browser nonce and host, work once and respect revocation", async () => {
        await enrollTotp();
        const unauthenticated = await proxyRequest("/settings");
        expect(unauthenticated.status).toBe(302);
        const destination = new URL(unauthenticated.headers.get("location") ?? "");
        const target = destination.searchParams.get("target"),
            nonce = destination.searchParams.get("nonce");
        const minted = await json(
            post("/api/sso/complete", { target, nonce }),
            v.object({ redirect: v.string() })
        );
        const callback = new URL(minted.redirect);
        const wrong = await proxyRequest(
            callback.pathname + callback.search,
            "__Host-homelab_sso_nonce=wrong"
        );
        expect(wrong.status).toBe(401);
        const accepted = await proxyRequest(
            callback.pathname + callback.search,
            `__Host-homelab_sso_nonce=${nonce ?? ""}`
        );
        expect(accepted.status).toBe(303);
        const cookie = accepted.headers
            .getSetCookie()
            .find((value) => value.startsWith("__Host-homelab_sso="))
            ?.split(";")[0];
        if (!cookie) throw new Error("Resource session cookie missing");
        expect(
            await status(
                proxyRequest(
                    callback.pathname + callback.search,
                    `__Host-homelab_sso_nonce=${nonce ?? ""}`
                )
            )
        ).toBe(400);
        const access = await proxyRequest("/settings", cookie);
        expect(access.status).toBe(200);
        expect(access.headers.get("Remote-User")).toBe(username);
        expect(await status(post("/api/logout", {}))).toBe(200);
        expect(await status(proxyRequest("/settings", cookie))).toBe(302);
    });
});

async function responseJson(promise: Promise<Response>): Promise<unknown> {
    const response = await promise;
    return response.json();
}

const tokenResponseSchema = v.object({
    access_token: v.string(),
    id_token: v.string(),
    refresh_token: v.optional(v.string()),
});
function formPost(path: string, body: Record<string, string>, authorization?: string) {
    return browser(path, {
        method: "POST",
        headers: {
            "content-type": "application/x-www-form-urlencoded",
            ...(authorization ? { authorization } : {}),
            ...(new URL(path, issuer).pathname.startsWith("/session/")
                ? { origin: issuer }
                : {}),
        },
        body: new URLSearchParams(body).toString(),
    });
}
async function authorizationTokens(scope: string, clientId = "dashboard") {
    const verifier = "separate-test-verifier-at-least-43-random-characters";
    const challenge = Buffer.from(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
    ).toString("base64url");
    let response = await browser(
        "/authorize?" +
            new URLSearchParams({
                client_id: clientId,
                redirect_uri: issuer + "/callback",
                response_type: "code",
                scope,
                state: "state",
                nonce: "nonce",
                prompt: "consent",
                code_challenge: challenge,
                code_challenge_method: "S256",
            }).toString()
    );
    for (let index = 0; index < 12; index += 1) {
        const location = response.headers.get("location");
        if (!location) throw new Error("Authorization did not redirect");
        const url = new URL(location, issuer);
        if (url.pathname === "/callback") {
            const code = url.searchParams.get("code");
            if (!code) throw new Error("Authorization code missing");
            return json(
                formPost(
                    "/token",
                    {
                        ...(clientId === "dashboard"
                            ? { client_id: clientId, client_secret: clientSecret }
                            : {}),
                        grant_type: "authorization_code",
                        code,
                        code_verifier: verifier,
                        redirect_uri: issuer + "/callback",
                    },
                    clientId === "dashboard"
                        ? undefined
                        : "Basic " +
                              Buffer.from(clientId + ":" + clientSecret).toString(
                                  "base64"
                              )
                ),
                tokenResponseSchema
            );
        }
        if (url.pathname === "/sign-in") {
            const next = await approveTestInteraction();
            response = await browser(next.redirect);
        } else response = await browser(url.href);
    }
    throw new Error("Authorization did not complete");
}

async function emailProof(recipient: string, subjectPrefix: string): Promise<string> {
    await application.services.email.deliverPending();
    const message = delivered.findLast(
        (entry) => entry.to === recipient && entry.subject.startsWith(subjectPrefix)
    );
    const token = message?.text.match(/#token=([\w-]{43})/)?.[1];
    if (!token) throw new Error("Test email proof missing");
    return token;
}

async function approveTestInteraction(): Promise<{ redirect: string }> {
    const result = await json(post("/sign-in/complete", {}), oidcInteractionSchema);
    if ("redirect" in result) return result;
    const { interactionId, accountId } = result.consent;
    return json(
        post("/sign-in/complete", { interactionId, accountId, decision: "approve" }),
        v.object({ redirect: v.string() })
    );
}

async function pendingConsent(clientId: string): Promise<OidcConsent> {
    const verifier = "consent-test-verifier-at-least-43-random-characters";
    const challenge = Buffer.from(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))
    ).toString("base64url");
    let response = await browser(
        "/authorize?" +
            new URLSearchParams({
                client_id: clientId,
                redirect_uri: issuer + "/callback",
                response_type: "code",
                scope: "openid profile email",
                prompt: "consent",
                state: "consent-state",
                code_challenge: challenge,
                code_challenge_method: "S256",
            }).toString()
    );
    for (let count = 0; count < 10; count += 1) {
        const location = response.headers.get("location");
        if (!location) throw new Error("Consent did not redirect");
        const target = new URL(location, issuer);
        if (target.pathname === "/sign-in") {
            const result = await json(
                post("/sign-in/complete", {}),
                oidcInteractionSchema
            );
            if ("consent" in result) return result.consent;
            response = await browser(result.redirect);
        } else response = await browser(target.href);
    }
    throw new Error("Consent was not requested");
}
