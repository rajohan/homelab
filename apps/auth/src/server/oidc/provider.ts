import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { oidcConsentSchema, type OidcInteraction } from "@homelab/contracts";
import { and, eq } from "drizzle-orm";
import { Provider, errors, interactionPolicy } from "oidc-provider";
import * as v from "valibot";

import { connectAuthDatabase } from "../database/connection";
import { grantSessions, users } from "../database/schema";
import { cookieName, readAuthCookie } from "../http/httpSecurity";
import { type Accounts, type Principal } from "../security/accounts";
import { encryptValue, randomToken, tokenDigest } from "../security/crypto";
import { AuthFailure } from "../security/errors";
import { audit } from "../security/store";
import { createOidcAdapter } from "./adapter";
import { hasClientApproval, rememberClientApproval } from "./approvals";
import { readConsentDecision } from "./consent";
import { createOidcFetch } from "./fetch";
import { serializeInteraction } from "./interactionLock";

async function cookiePrincipal(
    accounts: Accounts,
    cookie: string | undefined
): Promise<Principal | undefined> {
    const token = readAuthCookie(cookie, accounts.configuration);
    if (!token) return;
    try {
        const principal = await accounts.principalByToken(token);
        await accounts.requireAuthenticated(principal);
        return principal;
    } catch (error) {
        if (error instanceof AuthFailure) return;
        throw error;
    }
}

/**
 * Configure the OIDC engine with persistent grants and Homelab session policy.
 * @param accounts - Account storage, current keys and registered client settings.
 * @returns The configured OIDC provider.
 */
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
                if (clientId && !clientAllowed(accounts, principal, clientId))
                    return true;
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
        adapter: createOidcAdapter(
            accounts.database,
            configuration.encryptionKey,
            configuration.sessionPolicy
        ),
        jwks: configuration.jwks,
        cookies: {
            keys: [configuration.cookieKey],
            short: { sameSite: "lax", secure: !configuration.development },
            long: { sameSite: "lax", secure: !configuration.development },
        },
        features: {
            devInteractions: { enabled: false },
            backchannelLogout: { enabled: true },
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
        fetch: createOidcFetch(configuration.clients),
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
                token.clientId === configuration.dashboardClientId
                    ? configuration.sessionPolicy.rememberMaximumSeconds
                    : 600,
            AuthorizationCode: 60,
            RefreshToken: configuration.sessionPolicy.rememberMaximumSeconds,
            Session: configuration.sessionPolicy.rememberMaximumSeconds,
            Interaction: 600,
            Grant: configuration.sessionPolicy.rememberMaximumSeconds,
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
            const metadata = clientId
                ? configurationClient(accounts, clientId)
                : undefined;
            const scope =
                typeof context.oidc.params?.scope === "string"
                    ? context.oidc.params.scope
                    : "openid";
            if (
                !binding ||
                !metadata ||
                !(await hasClientApproval(
                    accounts.database,
                    principal.user.id,
                    metadata,
                    scope
                ))
            )
                return;
            return provider.Grant.find(grantId);
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
    const completedLogouts = new WeakMap<object, string>();
    provider.on("end_session.success", (context) => {
        const accountId = context.oidc.session?.accountId;
        if (context.oidc.params?.logout && accountId)
            completedLogouts.set(context, accountId);
    });
    provider.use(async (context, next) => {
        context.set("X-Content-Type-Options", "nosniff");
        context.set("Referrer-Policy", "no-referrer");
        // An empty script source list denies scripts until the provider adds the
        // exact hash of its built-in account-switch or form-post submission.
        context.set(
            "Content-Security-Policy",
            "default-src 'none'; script-src; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
        );
        await next();
        if (completedLogouts.get(context)) {
            const principal = await cookiePrincipal(accounts, context.req.headers.cookie);
            // Account switching logs out the previous protocol account, not the
            // newly authenticated central identity carried by the current cookie.
            if (principal && principal.user.id === completedLogouts.get(context)) {
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

/**
 * Start the internal loopback HTTP bridge required by the OIDC provider.
 * @param accounts - The account service used by provider authentication and interactions.
 * @returns The provider and its loopback listener handles.
 */
export async function startProviderListener(accounts: Accounts) {
    const provider = createProvider(accounts);
    // Reserve one of the service's eight connections for interaction ordering.
    // This keeps held advisory locks out of the pool used by provider operations.
    const interactions = connectAuthDatabase(accounts.configuration.databaseUrl, 1);
    const callback = provider.callback();
    const server = createServer((request, response) => {
        const url = new URL(request.url ?? "/", accounts.configuration.issuer);
        if (url.pathname === "/sign-in/complete" && request.method === "POST") {
            void provider
                .interactionDetails(request, response)
                .then((details) =>
                    serializeInteraction(interactions.database, details.uid, () =>
                        completeInteraction(accounts, provider, request, response)
                    )
                )
                .catch((error: unknown) => {
                    if (!response.headersSent) {
                        let status = 403;
                        let code = "SIGN_IN_FAILED";
                        let message =
                            "Sign-in could not be completed. Try again or use another account.";
                        if (error instanceof errors.SessionNotFound) {
                            status = 410;
                            code = "INTERACTION_EXPIRED";
                            message =
                                "This sign-in request has expired. Start a new sign-in to continue.";
                        } else if (
                            error instanceof AuthFailure &&
                            ["CONSENT_CONFLICT", "CONSENT_BUSY"].includes(error.code)
                        ) {
                            status = 409;
                            code = error.code;
                            message = error.message;
                        }
                        response.writeHead(status, {
                            "Content-Type": "application/json",
                            "Cache-Control": "no-store",
                        });
                        response.end(JSON.stringify({ code, message }));
                    }
                });
        } else void callback(request, response);
    });
    try {
        await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(0, "127.0.0.1", resolve);
        });
    } catch (error) {
        await interactions.client.close();
        throw error;
    }
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
            await interactions.client.close();
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
    const decision = await readConsentDecision(request);
    const principal = await cookiePrincipal(accounts, request.headers.cookie);
    if (!principal) throw new Error("Sign in first");
    const details = await provider.interactionDetails(request, response);
    const clientId = details.params.client_id;
    if (
        typeof clientId !== "string" ||
        !accounts.configuration.clients.some((client) => client.client_id === clientId)
    )
        throw new Error("Unknown client");
    if (!clientAllowed(accounts, principal, clientId))
        throw new Error("Client access denied");
    if (clientId !== accounts.configuration.dashboardClientId && !principal.session.mfaAt)
        throw new Error("Two-factor authentication is required");
    if (
        decision &&
        (details.prompt.name !== "consent" ||
            decision.interactionId !== details.uid ||
            decision.accountId !== principal.user.id)
    )
        throw new Error("Consent no longer matches this sign-in");
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
        // A retry after a lost response must resume the accepted decision, not mint another grant.
        if (details.result?.consent || details.result?.error) {
            const recorded = details.result.consent ? "approve" : "deny";
            if (decision && decision.decision !== recorded)
                throw new AuthFailure(
                    "CONSENT_CONFLICT",
                    409,
                    "This request already has a different decision. Start a new sign-in to change it."
                );
            replyInteraction(response, { redirect: details.returnTo });
            return;
        }
        const metadata = configurationClient(accounts, clientId);
        if (!metadata) throw new Error("Unknown client");
        const scope =
            typeof details.params.scope === "string" ? details.params.scope : "openid";
        const forceConsent =
            typeof details.params.prompt === "string" &&
            details.params.prompt.split(" ").includes("consent");
        const remembered =
            !forceConsent &&
            (await hasClientApproval(
                accounts.database,
                principal.user.id,
                metadata,
                scope
            ));
        if (!decision && !remembered) {
            if (typeof details.params.redirect_uri !== "string")
                throw new Error("Missing registered redirect");
            replyInteraction(response, {
                consent: v.parse(oidcConsentSchema, {
                    interactionId: details.uid,
                    accountId: principal.user.id,
                    clientId,
                    clientName: metadata?.client_name ?? clientId,
                    username: principal.user.username,
                    redirectOrigin: new URL(details.params.redirect_uri).origin,
                    scopes: [...new Set(scope.split(" ").filter(Boolean))],
                }),
            });
            return;
        }
        if (decision?.decision === "deny") {
            const redirect = await provider.interactionResult(
                request,
                response,
                {
                    error: "access_denied",
                    error_description: "Access was denied by the user.",
                },
                { mergeWithLastSubmission: false }
            );
            replyInteraction(response, { redirect });
            return;
        }
        const grant = new provider.Grant({ accountId: principal.user.id, clientId });
        if (
            scope.split(" ").includes("account") &&
            clientId !== accounts.configuration.dashboardClientId
        )
            throw new Error("Account access is restricted to the dashboard");
        grant.addOIDCScope(scope);
        const grantId = await grant.save();
        const protocolSession = details.session?.uid
            ? await provider.Session.findByUid(details.session.uid)
            : undefined;
        if (!protocolSession || protocolSession.accountId !== principal.user.id)
            throw new Error("OIDC session changed");
        // A new grant receives a new sid, so a delayed logout cannot terminate a later login.
        const sid = randomToken();
        protocolSession.sidFor(clientId, sid);
        await protocolSession.persist();
        const digest = tokenDigest(grantId);
        await accounts.database.transaction(async (transaction) => {
            await transaction
                .select({ id: users.id })
                .from(users)
                .where(eq(users.id, principal.user.id))
                .for("update");
            const current = await accounts.principalById(
                principal.session.id,
                transaction
            );
            await accounts.requireAuthenticated(current, transaction);
            if (!clientAllowed(accounts, current, clientId))
                throw new Error("Client access denied");
            if (
                clientId !== accounts.configuration.dashboardClientId &&
                !current.session.mfaAt
            )
                throw new Error("Two-factor authentication is required");
            if (decision?.decision === "approve") {
                await rememberClientApproval(
                    transaction,
                    current.user.id,
                    metadata,
                    scope
                );
            } else if (
                !(await hasClientApproval(transaction, current.user.id, metadata, scope))
            ) {
                throw new Error("App approval was revoked");
            }
            await transaction.insert(grantSessions).values({
                grantId: digest,
                clientId,
                sessionId: current.session.id,
                userId: current.user.id,
                encryptedLogout: metadata?.backchannel_logout_uri
                    ? encryptValue(
                          accounts.configuration.encryptionKey,
                          `logout:${digest}`,
                          {
                              clientId,
                              accountId: current.user.id,
                              sid,
                              uri: metadata.backchannel_logout_uri,
                          }
                      )
                    : null,
            });
        });
        result = { consent: { grantId } };
    } else throw new Error("Unsupported interaction");
    const redirect = await provider.interactionResult(request, response, result, {
        mergeWithLastSubmission: false,
    });
    replyInteraction(response, { redirect });
}

function replyInteraction(response: ServerResponse, result: OidcInteraction): void {
    response.writeHead(200, {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
    });
    response.end(JSON.stringify(result));
}

/**
 * Authorize an account-scoped dashboard bearer token against its live central session.
 * @param accounts - The central account service.
 * @param provider - The OIDC engine that owns the token.
 * @param token - The presented bearer token.
 * @returns The active account and session principal.
 */
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

function configurationClient(accounts: Accounts, clientId: string) {
    return accounts.configuration.clients.find((client) => client.client_id === clientId);
}

function clientAllowed(
    accounts: Accounts,
    principal: Principal,
    clientId: string
): boolean {
    const groups = accounts.configuration.clientGroups?.[clientId] ?? ["admins"];
    return groups.some((group) => principal.user.groups.includes(group));
}
