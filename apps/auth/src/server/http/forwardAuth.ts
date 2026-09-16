import * as v from "valibot";

import { resourcePolicy } from "../config/accessPolicy";
import { type Accounts, type Principal } from "../security/accounts";
import { decryptValue, encryptValue, randomToken } from "../security/crypto";
import { AuthFailure, denied } from "../security/errors";
import { createChallenge, takeChallenge } from "../security/store";
import { secureJson, trustedProxy } from "./httpSecurity";

const resourceSession = "__Host-homelab_sso";
const resourceNonce = "__Host-homelab_sso_nonce";
const ticketSchema = v.object({ target: v.string(), nonce: v.string() });
const resourceSchema = v.object({
    sessionId: v.pipe(v.string(), v.uuid()),
    expiresAt: v.number(),
});

function readCookie(request: Request, name: string): string | undefined {
    const entries = (request.headers.get("cookie") ?? "")
        .split(";")
        .map((part) => part.trim())
        .filter((part) => part.startsWith(`${name}=`));
    return entries.length === 1 ? entries[0]?.slice(name.length + 1) : undefined;
}

function cookie(name: string, value: string, maxAge: number): string {
    return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

function safeTarget(accounts: Accounts, value: string): URL {
    const target = new URL(value);
    if (
        target.protocol !== "https:" ||
        target.username ||
        target.password ||
        target.hash ||
        !accounts.configuration.routes.some((route) => route.origin === target.origin)
    )
        throw new AuthFailure("INVALID_TARGET", 403, "SSO target is not allowed.");
    return target;
}

/**
 * Create a short-lived, one-use SSO handoff for an authorized target origin.
 * @param accounts - The central account service.
 * @param principal - The session completing the handoff.
 * @param targetValue - The requested, registered service URL.
 * @param nonce - The proxy-generated challenge that binds this handoff.
 * @returns The callback URL containing the one-use ticket.
 */
export async function createSsoTicket(
    accounts: Accounts,
    principal: Principal,
    targetValue: string,
    nonce: string
): Promise<string> {
    const target = safeTarget(accounts, targetValue);
    if (!/^[\w-]{43}$/.test(nonce))
        throw new AuthFailure("INVALID_TARGET", 400, "Invalid SSO challenge.");
    await accounts.requireAuthenticated(principal);
    if (!principal.session.mfaAt)
        throw new AuthFailure(
            "MFA_ENROLLMENT_REQUIRED",
            403,
            "Register and verify a security method first."
        );
    const ticket = await createChallenge(
        accounts.database,
        accounts.configuration.encryptionKey,
        principal.user.id,
        principal.session.id,
        "forward-auth",
        { target: target.href, nonce },
        60_000
    );
    return `${target.origin}/.homelab/sso/callback?ticket=${ticket}`;
}

/**
 * Apply the registered origin's access policy to a trusted reverse-proxy request.
 * @param request - A ForwardAuth request carrying authenticated proxy headers.
 * @param accounts - The central account service and access configuration.
 * @returns A policy decision, identity headers or sign-in handoff response.
 */
export async function forwardAuth(
    request: Request,
    accounts: Accounts
): Promise<Response> {
    const configuration = accounts.configuration;
    if (!trustedProxy(request, configuration))
        return secureJson({ error: "Untrusted proxy" }, 403);
    const scheme = request.headers.get("x-forwarded-proto");
    const host = request.headers.get("x-forwarded-host");
    const rawPath = request.headers.get("x-forwarded-uri");
    if (
        scheme !== "https" ||
        !host ||
        /[\\/\s?#@]/.test(host) ||
        !rawPath?.startsWith("/") ||
        rawPath.startsWith("//") ||
        /[\\\r\n]/.test(rawPath)
    )
        return secureJson({ error: "Invalid proxy request" }, 403);
    const target = safeTarget(accounts, `https://${host}${rawPath}`);
    const authority = new URL(`https://${host}`);
    if (target.origin !== authority.origin)
        return secureJson({ error: "Invalid proxy target" }, 403);
    const rule = configuration.routes.find((route) => route.origin === target.origin);
    if (!rule) return secureJson({ error: "Access denied" }, 403);
    if (target.pathname === "/.homelab/sso/callback") {
        const ticket = target.searchParams.get("ticket");
        const nonce = readCookie(request, resourceNonce);
        if (!ticket || !nonce) return restartSso(target);
        try {
            return await accounts.database.transaction(async (transaction) => {
                const challenge = await takeChallenge(
                    transaction,
                    configuration.encryptionKey,
                    ticket,
                    "forward-auth"
                );
                const data = v.parse(ticketSchema, challenge.data);
                const returnTo = safeTarget(accounts, data.target);
                if (returnTo.origin !== target.origin || data.nonce !== nonce) denied();
                // The ticket's session binding is resolved before its one-time deletion.
                const principal = await accounts.principalById(
                    challenge.sessionId ?? "",
                    transaction
                );
                if (principal.user.id !== challenge.userId || !principal.session.mfaAt)
                    denied();
                const value = encryptValue(
                    configuration.encryptionKey,
                    `resource:${target.origin}`,
                    {
                        sessionId: principal.session.id,
                        expiresAt: principal.session.expiresAt.getTime(),
                    }
                );
                const response = new Response(null, {
                    status: 303,
                    headers: {
                        Location: returnTo.href,
                        "Cache-Control": "no-store",
                        "Referrer-Policy": "no-referrer",
                    },
                });
                response.headers.append(
                    "Set-Cookie",
                    cookie(
                        resourceSession,
                        value,
                        Math.max(
                            0,
                            Math.floor(
                                (principal.session.expiresAt.getTime() - Date.now()) /
                                    1000
                            )
                        )
                    )
                );
                response.headers.append("Set-Cookie", cookie(resourceNonce, "", 0));
                return response;
            });
        } catch (error) {
            // Never expose a spent handoff as a JSON page. Re-enter through the
            // registered origin, which must still pass the ordinary access policy.
            if (error instanceof AuthFailure && [400, 401, 403].includes(error.status))
                return restartSso(target);
            throw error;
        }
    }
    const access = resourcePolicy(rule, target.pathname);
    if (access.policy === "deny") return secureJson({ error: "Access denied" }, 403);
    if (access.policy === "bypass") return new Response(null, { status: 200 });
    const envelope = readCookie(request, resourceSession);
    if (envelope) {
        let session: v.InferOutput<typeof resourceSchema> | undefined;
        try {
            session = v.parse(
                resourceSchema,
                decryptValue(
                    configuration.encryptionKey,
                    `resource:${target.origin}`,
                    envelope
                )
            );
        } catch {
            session = undefined;
        }
        let principal: Principal | undefined;
        if (session && session.expiresAt > Date.now()) {
            try {
                principal = await accounts.principalById(session.sessionId);
            } catch (error) {
                if (!(error instanceof AuthFailure) || error.status !== 401) throw error;
            }
        }
        if (principal) {
            await accounts.requireAuthenticated(principal);
            if (
                !principal.session.mfaAt ||
                !access.groups.some((group) => principal.user.groups.includes(group))
            )
                return secureJson({ error: "Access denied" }, 403);
            const origin = request.headers.get("origin");
            const site = request.headers.get("sec-fetch-site");
            if (
                (origin === null || origin === target.origin) &&
                (site === null || site === "same-origin") &&
                (origin === target.origin || site === "same-origin")
            )
                await accounts.touch(principal);
            return new Response(null, {
                status: 200,
                headers: {
                    "Remote-User": principal.user.username,
                    "Remote-Name": principal.user.username,
                    "Remote-Email": principal.user.email,
                    "Remote-Groups": principal.user.groups.join(","),
                    "Cache-Control": "no-store",
                },
            });
        }
    }
    const nonce = randomToken();
    const login = new URL("/sso", configuration.issuer);
    login.searchParams.set("target", target.href);
    login.searchParams.set("nonce", nonce);
    return new Response(null, {
        status: 302,
        headers: {
            Location: login.href,
            "Set-Cookie": cookie(resourceNonce, nonce, 600),
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
        },
    });
}

function restartSso(target: URL): Response {
    return new Response(null, {
        status: 303,
        headers: {
            Location: target.origin + "/",
            "Cache-Control": "no-store",
            "Referrer-Policy": "no-referrer",
            "Set-Cookie": cookie(resourceNonce, "", 0),
        },
    });
}
