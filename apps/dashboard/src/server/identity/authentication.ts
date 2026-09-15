import { EncryptJWT, jwtDecrypt } from "jose";
import * as oidc from "openid-client";
import * as v from "valibot";

import type { DashboardAuthConfiguration } from "../config/auth";

const stateSchema = v.object({
    state: v.string(),
    verifier: v.string(),
    nonce: v.string(),
    returnTo: v.string(),
});
const accessSchema = v.object({ accessToken: v.string() });

/**
 * Create OIDC login and account-proxy handlers with encrypted, purpose-bound cookies.
 * @param configuration - Validated issuer, client credentials, session key and dashboard origin.
 * @returns Login, callback, proxy and central-session verification handlers.
 */
export function createDashboardAuthentication(configuration: DashboardAuthConfiguration) {
    const sessionName = configuration.development
        ? "homelab_dashboard"
        : "__Host-homelab_dashboard";
    const loginName = configuration.development
        ? "homelab_login"
        : "__Host-homelab_login";
    let discovery: Promise<oidc.Configuration> | undefined;

    function discover(): Promise<oidc.Configuration> {
        discovery ??= oidc
            .discovery(
                new URL(configuration.issuer),
                configuration.clientId,
                { client_secret: configuration.clientSecret },
                configuration.tokenEndpointAuthMethod === "client_secret_basic"
                    ? oidc.ClientSecretBasic(configuration.clientSecret)
                    : oidc.ClientSecretPost(configuration.clientSecret),
                {
                    ...(configuration.development
                        ? { execute: [oidc.allowInsecureRequests] }
                        : {}),
                    timeout: 10,
                }
            )
            .catch((error) => {
                discovery = undefined;
                throw error;
            });
        return discovery;
    }
    function cookie(name: string, value: string, maxAge: number): string {
        return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${configuration.development ? "" : "; Secure"}`;
    }

    async function seal(
        value: Record<string, unknown>,
        purpose: string,
        ttl: number
    ): Promise<string> {
        return new EncryptJWT(value)
            .setProtectedHeader({ alg: "dir", enc: "A256GCM" })
            .setIssuer("homelab-dashboard")
            .setAudience(`${configuration.origin}:${purpose}`)
            .setIssuedAt()
            .setExpirationTime(`${ttl}s`)
            .encrypt(configuration.sessionKey);
    }
    async function open(value: string | undefined, purpose: string): Promise<unknown> {
        if (!value) throw new Error("Session missing");
        const result = await jwtDecrypt(value, configuration.sessionKey, {
            issuer: "homelab-dashboard",
            audience: `${configuration.origin}:${purpose}`,
            keyManagementAlgorithms: ["dir"],
            contentEncryptionAlgorithms: ["A256GCM"],
        });
        return result.payload;
    }
    function safeReturn(path: string | null): string {
        if (
            !path ||
            !path.startsWith("/") ||
            path.startsWith("//") ||
            /[\\\r\n]/.test(path)
        )
            return "/settings";
        const target = new URL(path, configuration.origin);
        return target.origin === configuration.origin &&
            !target.pathname.startsWith("/auth/") &&
            target.pathname !== "/login"
            ? `${target.pathname}${target.search}${target.hash}`
            : "/settings";
    }
    async function begin(request: Request): Promise<Response> {
        const state = oidc.randomState();
        const verifier = oidc.randomPKCECodeVerifier();
        const nonce = oidc.randomNonce();
        const returnTo = safeReturn(new URL(request.url).searchParams.get("returnTo"));
        const authorization = oidc.buildAuthorizationUrl(await discover(), {
            redirect_uri: `${configuration.origin}/auth/callback`,
            response_type: "code",
            scope: "openid profile email groups account",
            state,
            nonce,
            code_challenge: await oidc.calculatePKCECodeChallenge(verifier),
            code_challenge_method: "S256",
        });
        return new Response(null, {
            status: 302,
            headers: {
                Location: authorization.href,
                "Set-Cookie": cookie(
                    loginName,
                    await seal({ state, verifier, nonce, returnTo }, "login", 600),
                    600
                ),
                "Cache-Control": "no-store",
            },
        });
    }
    async function callback(request: Request): Promise<Response> {
        const state = v.parse(
            stateSchema,
            await open(readCookie(request, loginName), "login")
        );
        const incoming = new URL(request.url);
        const callbackUrl = new URL(
            `${incoming.pathname}${incoming.search}`,
            configuration.origin
        );
        const result = await oidc.authorizationCodeGrant(await discover(), callbackUrl, {
            expectedState: state.state,
            expectedNonce: state.nonce,
            pkceCodeVerifier: state.verifier,
            idTokenExpected: true,
        });
        if (!result.claims()?.sub) throw new Error("Identity claim missing");
        const duration = Math.min(result.expires_in ?? 600, 43_200);
        const response = new Response(null, {
            status: 303,
            headers: {
                Location: safeReturn(state.returnTo),
                "Cache-Control": "no-store",
            },
        });
        response.headers.append(
            "Set-Cookie",
            cookie(
                sessionName,
                await seal({ accessToken: result.access_token }, "session", duration),
                duration
            )
        );
        response.headers.append("Set-Cookie", cookie(loginName, "", 0));
        return response;
    }
    async function proxy(request: Request, activity = false): Promise<Response> {
        const path = new URL(request.url).pathname;
        const allowed =
            path === "/api/session" ||
            path === "/api/account" ||
            path === "/api/logout" ||
            /^\/api\/account\/[a-z/-]+$/.test(path);
        if (!allowed || !["GET", "POST"].includes(request.method))
            return Response.json(
                { code: "NOT_FOUND", message: "Not found." },
                { status: 404 }
            );
        if (
            request.method === "POST" &&
            (request.headers.get("origin") !== configuration.origin ||
                request.headers.get("content-type")?.split(";")[0]?.trim() !==
                    "application/json")
        ) {
            return Response.json(
                { code: "INVALID_ORIGIN", message: "Request origin is not allowed." },
                { status: 403 }
            );
        }
        let token: v.InferOutput<typeof accessSchema>;
        try {
            token = v.parse(
                accessSchema,
                await open(readCookie(request, sessionName), "session")
            );
        } catch {
            if (path === "/api/session")
                return Response.json(
                    { authenticated: false, mfaRequired: false, methods: [] },
                    { headers: { "Cache-Control": "no-store" } }
                );
            return Response.json(
                { code: "UNAUTHORIZED", message: "Sign in to continue." },
                { status: 401, headers: { "Cache-Control": "no-store" } }
            );
        }
        const response = await fetch(new URL(path, configuration.issuer), {
            method: request.method,
            headers: {
                Authorization: `Bearer ${token.accessToken}`,
                "Content-Type": "application/json",
                Origin: configuration.origin,
                ...(activity ? { "X-Homelab-Session-Activity": "1" } : {}),
            },
            ...(request.method === "POST" ? { body: await request.arrayBuffer() } : {}),
            redirect: "error",
            signal: AbortSignal.timeout(15_000),
        });
        const forwarded = new Response(response.body, {
            status: response.status,
            headers: {
                "Content-Type": "application/json",
                "Cache-Control": "no-store",
                "X-Content-Type-Options": "nosniff",
            },
        });
        if (response.status === 401 || (path === "/api/logout" && response.ok))
            forwarded.headers.append("Set-Cookie", cookie(sessionName, "", 0));
        return forwarded;
    }
    async function authenticated(request: Request): Promise<boolean> {
        const check = await proxy(
            new Request(new URL("/api/session", request.url).href, {
                headers: request.headers,
            }),
            true
        );
        if (!check.ok) return false;
        return v.parse(v.object({ authenticated: v.boolean() }), await check.json())
            .authenticated;
    }
    return { begin, callback, proxy, authenticated };
}

function readCookie(request: Request, name: string): string | undefined {
    const matches = (request.headers.get("cookie") ?? "")
        .split(";")
        .map((part) => part.trim())
        .filter((part) => part.startsWith(`${name}=`));
    return matches.length === 1 ? matches[0]?.slice(name.length + 1) : undefined;
}
