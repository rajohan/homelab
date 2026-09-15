import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";

import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/bun-sql/migrator";
import { TOTP } from "otpauth";
import * as v from "valibot";

import { createAuthApplication } from "../application";
import type { AuthConfiguration } from "../config/configuration";
import {
    factors,
    sessions,
    users,
    mailOutbox,
    rateBuckets,
    oidcRecords,
    challenges,
} from "../database/schema";
import { hashPassword, tokenDigest } from "../security/crypto";
import type { AuthEmail } from "../security/email";
import { softwareAuthenticator } from "../testing/webauthnFixture";

let application: Awaited<ReturnType<typeof createAuthApplication>>;
let server: ReturnType<typeof Bun.serve>;
let issuer: string;
const delivered: AuthEmail[] = [];
const password = "isolated-test-password-not-production";
const clientSecret = "isolated-client-secret-for-tests-only-32-characters";
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
    const databaseUrl = process.env.HOMELAB_TEST_DATABASE_URL;
    if (!databaseUrl)
        throw new Error(
            "HOMELAB_TEST_DATABASE_URL must point to the isolated test database"
        );
    const target = new URL(databaseUrl);
    if (
        !["localhost", "127.0.0.1"].includes(target.hostname) ||
        target.pathname !== "/homelab_auth_test"
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
                const completed = await post("/sign-in/complete", {});
                if (completed.status !== 200)
                    throw new Error(`Interaction failed: ${await completed.text()}`);
                const next = v.parse(
                    v.object({ redirect: v.string() }),
                    await completed.json()
                );
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
function proxyRequest(uri: string, cookie?: string, trusted = true) {
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
        },
    });
}

describe("security invariants against the isolated database", () => {
    let username: string;
    beforeEach(async () => {
        cookieJar.clear();
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

    test("ForwardAuth rejects untrusted proxies and limits public exceptions", async () => {
        expect(await status(proxyRequest("/public/catalog.json", undefined, false))).toBe(
            403
        );
        expect(await status(proxyRequest("/manifest.webmanifest"))).toBe(200);
        expect(await status(proxyRequest("/public/catalog.json"))).toBe(200);
        expect(await status(proxyRequest("/publicity/settings"))).toBe(302);
        expect(await status(proxyRequest("/public/%2fadmin"))).toBe(302);
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
            const next = await json(
                post("/sign-in/complete", {}),
                v.object({ redirect: v.string() })
            );
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
