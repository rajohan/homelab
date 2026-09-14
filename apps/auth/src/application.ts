import { sql, lt, or } from "drizzle-orm";
import { Effect } from "effect";
import * as v from "valibot";

import { accountApi } from "./accountApi";
import type { AuthConfiguration } from "./configuration";
import { connectAuthDatabase } from "./database/connection";
import {
    auditEvents,
    sessions,
    challenges,
    mailOutbox,
    oidcRecords,
    rateBuckets,
} from "./database/schema";
import { forwardAuth } from "./forwardAuth";
import { secureJson } from "./httpSecurity";
import { startProviderListener } from "./oidc/provider";
import { Accounts } from "./security/accounts";
import { AccountEmail, type EmailDelivery } from "./security/email";
import { AuthFailure } from "./security/errors";
import { MultiFactor } from "./security/mfa";

export async function createAuthApplication(
    configuration: AuthConfiguration,
    delivery?: EmailDelivery
) {
    const connection = connectAuthDatabase(configuration.databaseUrl);
    const accounts = new Accounts(connection.database, configuration);
    const email = new AccountEmail(accounts, delivery);
    const mfa = new MultiFactor(accounts);
    const listener = await startProviderListener(accounts).catch(
        async (error: unknown) => {
            await connection.client.close();
            throw error;
        }
    );
    const services = { accounts, email, mfa, provider: listener.provider };
    const protocolPrefixes = [
        "/authorize",
        "/token",
        "/userinfo",
        "/jwks",
        "/introspect",
        "/revoke",
        "/session",
        "/.well-known",
    ];

    async function proxyProtocol(request: Request): Promise<Response> {
        const original = new URL(request.url);
        const headers = new Headers(request.headers);
        for (const name of headers.keys())
            if (name.startsWith("x-forwarded-") || name === "forwarded")
                headers.delete(name);
        const issuer = new URL(configuration.issuer);
        headers.set("x-forwarded-proto", issuer.protocol.slice(0, -1));
        headers.set("x-forwarded-host", issuer.host);
        headers.set("host", issuer.host);
        const body =
            request.method === "GET" || request.method === "HEAD"
                ? undefined
                : await request.arrayBuffer();
        return fetch(`${listener.origin}${original.pathname}${original.search}`, {
            method: request.method,
            headers,
            ...(body ? { body } : {}),
            redirect: "manual",
            signal: AbortSignal.timeout(15_000),
        });
    }

    async function dispatch(
        request: Request,
        remoteAddress = "unknown"
    ): Promise<Response> {
        const path = new URL(request.url).pathname;
        if (path === "/health/live")
            return secureJson({
                service: "auth",
                status: "ok",
                authenticationImplemented: true,
            });
        if (path === "/health/ready") {
            await connection.database.execute(sql`select id from auth_users limit 1`);
            return secureJson({
                service: "auth",
                status: "ok",
                authenticationImplemented: true,
            });
        }
        if (path === "/api/authz/forward-auth")
            return await forwardAuth(request, accounts);
        if (
            path === "/sign-in/complete" ||
            protocolPrefixes.some(
                (prefix) => path === prefix || path.startsWith(`${prefix}/`)
            )
        )
            return await proxyProtocol(request);
        return await accountApi(request, services, remoteAddress);
    }

    function handle(request: Request, remoteAddress = "unknown"): Promise<Response> {
        return Effect.runPromise(
            Effect.tryPromise({
                try: () => dispatch(request, remoteAddress),
                catch: (error: unknown) => error,
            }).pipe(
                Effect.match({
                    onFailure: failureResponse,
                    onSuccess: (response) => response,
                })
            )
        );
    }

    let maintenance: Promise<void> | undefined;
    let closing = false;
    async function runMaintenance(): Promise<void> {
        await email.deliverPending();
        const now = new Date();
        const expiredSessions = await connection.database
            .select({ id: sessions.id })
            .from(sessions)
            .where(
                or(
                    lt(sessions.expiresAt, now),
                    lt(sessions.lastSeenAt, new Date(now.getTime() - 3_600_000))
                )
            )
            .limit(100);
        for (const session of expiredSessions)
            await connection.database.transaction((transaction) =>
                accounts.revoke(transaction, session.id)
            );
        await connection.database
            .delete(auditEvents)
            .where(lt(auditEvents.createdAt, new Date(now.getTime() - 90 * 86_400_000)));
        await connection.database.delete(challenges).where(lt(challenges.expiresAt, now));
        await connection.database
            .delete(oidcRecords)
            .where(lt(oidcRecords.expiresAt, now));
        await connection.database
            .delete(rateBuckets)
            .where(lt(rateBuckets.expiresAt, now));
        await connection.database.delete(mailOutbox).where(lt(mailOutbox.expiresAt, now));
    }
    function maintain(): Promise<void> {
        if (closing) return Promise.resolve();
        maintenance ??= runMaintenance().finally(() => {
            maintenance = undefined;
        });
        return maintenance;
    }
    return {
        handle,
        services,
        connection,
        maintain,
        close: async () => {
            closing = true;
            await maintenance?.catch(() => {});
            await listener.close();
            await connection.client.close();
        },
    };
}

function failureResponse(error: unknown): Response {
    if (error instanceof AuthFailure)
        return secureJson({ code: error.code, message: error.message }, error.status);
    if (v.isValiError(error) || error instanceof SyntaxError)
        return secureJson(
            { code: "INVALID_INPUT", message: "Check the submitted fields." },
            400
        );
    process.stderr.write(
        JSON.stringify({ service: "auth", event: "request_failed" }) + "\n"
    );
    return secureJson(
        {
            code: "UNAVAILABLE",
            message: "The request could not be completed. Try again.",
        },
        503
    );
}
