import type {
    AuthenticationResponseJSON,
    RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type Provider from "oidc-provider";
import * as v from "valibot";

import { tokenPrincipal } from "../oidc/provider";
import { type Accounts, type Principal } from "../security/accounts";
import type { AccountEmail } from "../security/email";
import { AuthFailure, denied } from "../security/errors";
import type { MultiFactor } from "../security/mfa";
import { audit, rateLimit } from "../security/store";
import { createSsoTicket } from "./forwardAuth";
import {
    assertMutationOrigin,
    readAuthCookie,
    secureJson,
    sessionCookie,
    trustedProxy,
} from "./httpSecurity";

const text = (maximum: number) =>
    v.pipe(v.string(), v.minLength(1), v.maxLength(maximum));
const password = v.pipe(v.string(), v.minLength(8), v.maxLength(256));
const newPassword = v.pipe(v.string(), v.minLength(12), v.maxLength(256));
const identifier = v.pipe(v.string(), v.uuid());
const label = v.pipe(text(64), v.regex(/^[^\p{Cc}]+$/u));
const token = v.pipe(v.string(), v.regex(/^[\w-]{43}$/));
const credentialBase = {
    id: text(2048),
    rawId: text(2048),
    type: v.literal("public-key"),
    clientExtensionResults: v.record(v.string(), v.unknown()),
    authenticatorAttachment: v.optional(v.picklist(["platform", "cross-platform"])),
};
const registration = v.object({
    ...credentialBase,
    response: v.object({
        clientDataJSON: text(8192),
        attestationObject: text(48_000),
        transports: v.optional(
            v.array(
                v.picklist([
                    "ble",
                    "cable",
                    "hybrid",
                    "internal",
                    "nfc",
                    "smart-card",
                    "usb",
                ])
            )
        ),
    }),
});
const assertion = v.object({
    ...credentialBase,
    response: v.object({
        clientDataJSON: text(8192),
        authenticatorData: text(8192),
        signature: text(8192),
        userHandle: v.optional(text(2048)),
    }),
});

export interface IdentityServices {
    readonly accounts: Accounts;
    readonly email: AccountEmail;
    readonly mfa: MultiFactor;
    readonly provider: Provider;
}

/**
 * Resolve the current identity from an account bearer token or central session cookie.
 * @param request - The incoming authenticated account request.
 * @param services - The identity services used to verify it.
 * @returns The live account/session principal.
 */
export async function requestPrincipal(
    request: Request,
    services: IdentityServices
): Promise<Principal> {
    const authorization = request.headers.get("authorization");
    if (authorization) {
        if (!authorization.startsWith("Bearer ")) denied();
        return tokenPrincipal(
            services.accounts,
            services.provider,
            authorization.slice(7)
        );
    }
    const value = readAuthCookie(
        request.headers.get("cookie"),
        services.accounts.configuration
    );
    if (!value) denied();
    return services.accounts.principalByToken(value);
}

/**
 * Handle the bounded account, session and proof API routes.
 * @param request - The incoming account API request.
 * @param services - The configured identity services.
 * @param remoteAddress - The trusted peer identifier used for rate limiting.
 * @returns The route's private JSON response.
 */
export async function accountApi(
    request: Request,
    services: IdentityServices,
    remoteAddress: string
): Promise<Response> {
    const { accounts, email, mfa } = services;
    const configuration = accounts.configuration;
    const path = new URL(request.url).pathname;
    if (request.method === "GET" && path === "/api/session") {
        try {
            const principal = await requestPrincipal(request, services);
            const methods = await mfa.methods(principal);
            // Passive browser polling must not defeat idle expiration. Only the
            // authenticated dashboard BFF marks actual API work as activity.
            if (
                request.headers.get("authorization")?.startsWith("Bearer ") &&
                request.headers.get("x-homelab-session-activity") === "1" &&
                (methods.length === 0 || principal.session.mfaAt !== null)
            ) {
                await accounts.requireAuthenticated(principal);
                await accounts.touch(principal);
            }
            return secureJson({
                authenticated: methods.length === 0 || principal.session.mfaAt !== null,
                mfaRequired: methods.length > 0 && principal.session.mfaAt === null,
                username: principal.user.username,
                userId: principal.user.id,
                sessionId: principal.session.id,
                recoveryAvailable:
                    methods.length > 0 && (await mfa.hasRecoveryCodes(principal)),
                methods,
            });
        } catch (error) {
            if (error instanceof AuthFailure && error.status === 401)
                return secureJson({
                    authenticated: false,
                    mfaRequired: false,
                    methods: [],
                });
            throw error;
        }
    }
    if (request.method === "GET" && path === "/api/account")
        return secureJson(
            await accounts.snapshot(await requestPrincipal(request, services))
        );
    if (request.method !== "POST") return secureJson({ error: "Not found" }, 404);
    const origin = assertMutationOrigin(request, configuration);
    const body: unknown = await request.json();
    const remote = trustedProxy(request, configuration)
        ? (request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? remoteAddress)
        : remoteAddress;
    await rateLimit(accounts.database, `api:${remote}`, 180, 60_000);
    if (path === "/api/login") {
        const input = v.parse(v.strictObject({ username: text(100), password }), body);
        const result = await accounts.login(
            input.username,
            input.password,
            remote,
            request.headers.get("user-agent") ?? "Unknown browser"
        );
        const response = secureJson({ mfaRequired: result.mfaRequired });
        response.headers.append("Set-Cookie", sessionCookie(configuration, result.token));
        return response;
    }
    if (path === "/api/password/request-reset") {
        const input = v.parse(v.strictObject({ username: text(100) }), body);
        await email.requestReset(input.username, remote);
        return secureJson({
            message: "If the account has a verified email, a reset link will be sent.",
        });
    }
    if (path === "/api/password/reset") {
        const input = v.parse(v.strictObject({ token, password: newPassword }), body);
        await rateLimit(accounts.database, `password-reset:${remote}`, 5, 300_000);
        await email.resetPassword(input.token, input.password);
        return secureJson({ ok: true });
    }
    if (path === "/api/email/verify") {
        const input = v.parse(v.strictObject({ token }), body);
        await email.verifyEmail(input.token);
        return secureJson({ ok: true });
    }
    const principal = await requestPrincipal(request, services);
    if (path === "/api/sso/complete") {
        const input = v.parse(v.strictObject({ target: text(4096), nonce: token }), body);
        return secureJson({
            redirect: await createSsoTicket(
                accounts,
                principal,
                input.target,
                input.nonce
            ),
        });
    }
    if (path === "/api/logout") {
        v.parse(v.strictObject({}), body);
        await accounts.database.transaction((transaction) =>
            accounts.revoke(transaction, principal.session.id)
        );
        const response = secureJson({ ok: true });
        response.headers.append("Set-Cookie", sessionCookie(configuration, "", true));
        return response;
    }
    if (path === "/api/account/proof/password") {
        const input = v.parse(v.strictObject({ password }), body);
        await accounts.reauthenticatePassword(principal, input.password);
    } else if (
        path === "/api/account/proof/totp" ||
        path === "/api/account/proof/recovery"
    ) {
        const input = v.parse(v.strictObject({ code: text(64) }), body);
        await mfa.codeProof(principal, input.code, path.endsWith("/recovery"));
    } else if (path === "/api/account/proof/webauthn/begin") {
        v.parse(v.strictObject({}), body);
        return secureJson(await mfa.beginWebAuthnProof(principal, origin));
    } else if (path === "/api/account/proof/webauthn/finish") {
        const input = v.parse(v.strictObject({ token, response: assertion }), body);
        await mfa.webauthnProof(
            principal,
            input.token,
            input.response as AuthenticationResponseJSON
        );
    } else if (path === "/api/account/password") {
        const input = v.parse(
            v.strictObject({ currentPassword: password, newPassword }),
            body
        );
        await accounts.changePassword(
            principal,
            input.currentPassword,
            input.newPassword
        );
    } else if (path === "/api/account/email") {
        const input = v.parse(
            v.strictObject({
                email: v.pipe(v.string(), v.maxLength(254), v.email(), v.toLowerCase()),
            }),
            body
        );
        await email.requestEmail(principal, input.email);
    } else if (path === "/api/account/totp/begin") {
        const input = v.parse(v.strictObject({ label }), body);
        return secureJson(await mfa.beginTotp(principal, input.label));
    } else if (path === "/api/account/totp/finish") {
        const input = v.parse(v.strictObject({ token, code: text(6) }), body);
        return secureJson(await mfa.confirmTotp(principal, input.token, input.code));
    } else if (path === "/api/account/webauthn/begin") {
        v.parse(v.strictObject({}), body);
        return secureJson(await mfa.beginWebAuthn(principal, origin));
    } else if (path === "/api/account/webauthn/finish") {
        const input = v.parse(
            v.strictObject({ token, label, response: registration }),
            body
        );
        return secureJson(
            await mfa.confirmWebAuthn(
                principal,
                input.token,
                input.label,
                input.response as RegistrationResponseJSON
            )
        );
    } else if (path === "/api/account/factor/remove") {
        const input = v.parse(v.strictObject({ id: identifier }), body);
        await mfa.remove(principal, input.id);
    } else if (path === "/api/account/recovery/rotate") {
        v.parse(v.strictObject({}), body);
        return secureJson(
            await accounts.protectedAction(principal, async (transaction) => {
                if (!(await accounts.hasMfa(principal.user.id, transaction)))
                    throw new AuthFailure(
                        "MFA_ENROLLMENT_REQUIRED",
                        403,
                        "Register a security method first."
                    );
                const codes = await mfa.newRecoveryCodes(transaction, principal.user.id);
                await audit(transaction, principal.user.id, "recovery_codes_rotated");
                return { recoveryCodes: codes };
            })
        );
    } else if (path === "/api/account/session/revoke") {
        const input = v.parse(v.strictObject({ id: identifier }), body);
        await accounts.revokeSession(principal, input.id);
    } else if (path === "/api/account/sessions/revoke-others") {
        v.parse(v.strictObject({}), body);
        return secureJson(
            await accounts.protectedAction(principal, async (transaction) => {
                const revoked = await accounts.revokeOthers(transaction, principal);
                await audit(transaction, principal.user.id, "other_sessions_revoked");
                return { revoked };
            })
        );
    } else if (path === "/api/account/sessions/revoke-all") {
        v.parse(v.strictObject({}), body);
        await accounts.protectedAction(principal, async (transaction) => {
            await accounts.revokeOthers(transaction, principal);
            await accounts.revoke(transaction, principal.session.id);
            await audit(transaction, principal.user.id, "all_sessions_revoked");
        });
    } else return secureJson({ error: "Not found" }, 404);
    return secureJson({ ok: true });
}
