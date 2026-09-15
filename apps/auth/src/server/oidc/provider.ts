import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { and, eq } from "drizzle-orm";
import { Provider, interactionPolicy } from "oidc-provider";

import { grantSessions, users } from "../database/schema";
import { cookieName, readAuthCookie } from "../http/httpSecurity";
import { type Accounts, type Principal } from "../security/accounts";
import { tokenDigest } from "../security/crypto";
import { AuthFailure } from "../security/errors";
import { audit } from "../security/store";
import { createOidcAdapter } from "./adapter";

async function cookiePrincipal(
    accounts: Accounts,
    cookie: string | undefined
): Promise<Principal | undefined> {
    const token = readAuthCookie(cookie, accounts.configuration);
    if (!token) return undefined;
    try {
        const principal = await accounts.principalByToken(token);
        await accounts.requireAuthenticated(principal);
        return principal;
    } catch (error) {
        if (error instanceof AuthFailure) return undefined;
        throw error;
    }
}

export function createProvider(accounts: Accounts): Provider {
    const configuration = accounts.configuration;
    const policy = interactionPolicy.base();
    policy.get("login")?.checks.add(
        new interactionPolicy.Check(
            "homelab_session",
            "A current Homelab session is required",
            async (context) => {
                const principal = await cookiePrincipal(
                    accounts,
                    context.req.headers.cookie
                );
                if (!principal) return true;
                const clientId = context.oidc.client?.clientId;
                if (
                    clientId !== configuration.dashboardClientId &&
                    !principal.session.mfaAt
                )
                    return true;
                return context.oidc.session?.accountId !== principal.user.id;
            }
        )
    );
    const provider: Provider = new Provider(configuration.issuer, {
        clients: [...configuration.clients],
        adapter: createOidcAdapter(accounts.database, configuration.encryptionKey),
        jwks: configuration.jwks,
        cookies: {
            keys: [configuration.cookieKey],
            short: { sameSite: "lax", secure: !configuration.development },
            long: { sameSite: "lax", secure: !configuration.development },
        },
        features: {
            devInteractions: { enabled: false },
            rpInitiatedLogout: {
                enabled: true,
                logoutSource: (context, form) => {
                    context.type = "html";
                    context.body = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Sign out of Homelab</title><main><h1>Sign out of Homelab?</h1><p>This ends this browser's identity session and its connected grants.</p>${form}<button type="submit" form="op.logoutForm" name="logout" value="yes">Sign out</button><p><a href="/account">Cancel</a></p></main></html>`;
                },
                postLogoutSuccessSource: (context) => {
                    context.type = "html";
                    context.body =
                        '<!doctype html><html lang="en"><meta charset="utf-8"><title>Signed out</title><main><h1>You are signed out</h1><a href="/sign-in">Sign in again</a></main></html>';
                },
            },
            revocation: { enabled: true },
            introspection: { enabled: true },
        },
        pkce: { required: () => true },
        clientBasedCORS: () => false,
        rotateRefreshToken: true,
        routes: {
            authorization: "/authorize",
            token: "/token",
            userinfo: "/userinfo",
            jwks: "/jwks",
            revocation: "/revoke",
            introspection: "/introspect",
        },
        scopes: ["openid", "profile", "email", "groups", "offline_access", "account"],
        claims: {
            openid: ["sub"],
            profile: ["preferred_username", "name"],
            email: ["email", "email_verified"],
            groups: ["groups"],
        },
        ttl: {
            IdToken: 600,
            AccessToken: (_context, token) =>
                token.clientId === configuration.dashboardClientId ? 43_200 : 600,
            AuthorizationCode: 60,
            RefreshToken: 43_200,
            Session: 43_200,
            Interaction: 600,
            Grant: 43_200,
        },
        interactions: {
            policy,
            url: (_context, interaction) =>
                `${configuration.issuer}/sign-in?interaction=${encodeURIComponent(interaction.uid)}`,
        },
        loadExistingGrant: async (context) => {
            const clientId = context.oidc.client?.clientId;
            const grantId =
                context.oidc.result?.consent?.grantId ??
                (clientId ? context.oidc.session?.grantIdFor(clientId) : undefined);
            const principal = await cookiePrincipal(accounts, context.req.headers.cookie);
            if (!grantId || !principal) return;
            const [binding] = await accounts.database
                .select({ id: grantSessions.grantId })
                .from(grantSessions)
                .where(
                    and(
                        eq(grantSessions.grantId, tokenDigest(grantId)),
                        eq(grantSessions.sessionId, principal.session.id)
                    )
                );
            return binding ? provider.Grant.find(grantId) : undefined;
        },
        findAccount: async (_context, id) => {
            const [user] = await accounts.database
                .select()
                .from(users)
                .where(eq(users.id, id));
            if (!user) return;
            return {
                accountId: user.id,
                claims: () => ({
                    sub: user.id,
                    preferred_username: user.username,
                    name: user.username,
                    email: user.email,
                    email_verified: user.emailVerified,
                    groups: user.groups,
                }),
            };
        },
        renderError: (context, _output, error) => {
            process.stderr.write(
                JSON.stringify({
                    service: "auth",
                    event: "oidc_request_rejected",
                    code: "error" in error ? error.error : "invalid_request",
                }) + "\n"
            );
            context.type = "application/json";
            context.body = {
                error: "The authentication request could not be completed.",
            };
        },
    });
    // Mark only the library's CSRF-validated completion, then await our revocation
    // before Koa commits the response. EventEmitter callbacks alone are not awaited.
    const completedLogouts = new WeakMap<object, boolean>();
    provider.on("end_session.success", (context) => {
        completedLogouts.set(context, Boolean(context.oidc.params?.logout));
    });
    provider.use(async (context, next) => {
        await next();
        context.set("X-Content-Type-Options", "nosniff");
        context.set("Referrer-Policy", "no-referrer");
        if (!context.response.get("Content-Security-Policy"))
            context.set(
                "Content-Security-Policy",
                "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
            );
        if (completedLogouts.get(context)) {
            const principal = await cookiePrincipal(accounts, context.req.headers.cookie);
            if (principal)
                await accounts.database.transaction(async (transaction) => {
                    await accounts.revoke(transaction, principal.session.id);
                    await audit(
                        transaction,
                        principal.user.id,
                        "oidc_session_signed_out"
                    );
                });
            context.cookies.set(cookieName(configuration), null, {
                path: "/",
                httpOnly: true,
                sameSite: "lax",
                secure: !configuration.development,
            });
        }
    });
    provider.on("server_error", (_context, error) => {
        process.stderr.write(
            JSON.stringify({
                service: "auth",
                event: "oidc_server_error",
                kind: error.name,
            }) + "\n"
        );
    });
    provider.proxy = true;
    return provider;
}

export async function startProviderListener(accounts: Accounts) {
    const provider = createProvider(accounts);
    const callback = provider.callback();
    const server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", accounts.configuration.issuer);
        if (url.pathname === "/sign-in/complete" && request.method === "POST") {
            void completeInteraction(accounts, provider, request, response).catch(() => {
                if (!response.headersSent) {
                    response.writeHead(403, { "Content-Type": "application/json" });
                    response.end(
                        JSON.stringify({
                            error: "The sign-in request expired or could not be completed.",
                        })
                    );
                }
            });
        } else void callback(request, response);
    });
    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string")
        throw new Error("OIDC listener did not start");
    return {
        provider,
        origin: `http://127.0.0.1:${address.port}`,
        close: async () => {
            await new Promise<void>((resolve, reject) => {
                server.close((error) => (error ? reject(error) : resolve()));
                server.closeAllConnections();
            });
        },
    };
}

async function completeInteraction(
    accounts: Accounts,
    provider: Provider,
    request: IncomingMessage,
    response: ServerResponse
): Promise<void> {
    if (request.headers.origin !== accounts.configuration.issuer)
        throw new Error("Invalid interaction origin");
    const principal = await cookiePrincipal(accounts, request.headers.cookie);
    if (!principal) throw new Error("Sign in first");
    const details = await provider.interactionDetails(request, response);
    const clientId = details.params.client_id;
    if (
        typeof clientId !== "string" ||
        !accounts.configuration.clients.some((client) => client.client_id === clientId)
    )
        throw new Error("Unknown client");
    if (clientId !== accounts.configuration.dashboardClientId && !principal.session.mfaAt)
        throw new Error("Two-factor authentication is required");
    let result;
    if (details.prompt.name === "login") {
        result = {
            login: {
                accountId: principal.user.id,
                ts: Math.floor(principal.session.passwordAt.getTime() / 1000),
                acr: principal.session.mfaAt ? "urn:homelab:2fa" : "urn:homelab:password",
                amr: principal.session.mfaAt ? ["pwd", "mfa"] : ["pwd"],
            },
        };
    } else if (details.prompt.name === "consent") {
        if (details.session?.accountId !== principal.user.id)
            throw new Error("Account changed");
        const grant = new provider.Grant({ accountId: principal.user.id, clientId });
        const scope =
            typeof details.params.scope === "string" ? details.params.scope : "openid";
        if (
            scope.split(" ").includes("account") &&
            clientId !== accounts.configuration.dashboardClientId
        )
            throw new Error("Account access is restricted to the dashboard");
        grant.addOIDCScope(scope);
        const grantId = await grant.save();
        await accounts.database.insert(grantSessions).values({
            grantId: tokenDigest(grantId),
            sessionId: principal.session.id,
            userId: principal.user.id,
        });
        result = { consent: { grantId } };
    } else throw new Error("Unsupported interaction");
    const redirect = await provider.interactionResult(request, response, result, {
        mergeWithLastSubmission: false,
    });
    response.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
    });
    response.end(JSON.stringify({ redirect }));
}

export async function tokenPrincipal(
    accounts: Accounts,
    provider: Provider,
    token: string
): Promise<Principal> {
    const access = await provider.AccessToken.find(token);
    if (
        !access?.grantId ||
        access.clientId !== accounts.configuration.dashboardClientId ||
        !access.scope?.split(" ").includes("account") ||
        !access.accountId
    )
        throw new AuthFailure("UNAUTHORIZED", 401, "Sign in to continue.");
    const [grant] = await accounts.database
        .select()
        .from(grantSessions)
        .where(
            and(
                eq(grantSessions.grantId, tokenDigest(access.grantId)),
                eq(grantSessions.userId, access.accountId)
            )
        );
    if (!grant) throw new AuthFailure("UNAUTHORIZED", 401, "Sign in to continue.");
    return accounts.principalById(grant.sessionId);
}
